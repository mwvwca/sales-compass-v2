import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Upload, FileSpreadsheet, Download, RefreshCw, X, ChevronDown, ChevronRight, Info } from 'lucide-react';
import * as XLSX from '@e965/xlsx';
import { parseDrExport } from '@/lib/drParser';
import { mergeDrBatch } from '@/lib/drMerge';
import type { DealRegistration, RawDrRecord, DrStatus, Opportunity } from '@/types/forecast';
import { currentlySql, everReachedSql, daysSinceActivity } from '@/lib/drSql';


// ---------- Constants & helpers ----------
const STAGE_ORDER = ['Unqualified', 'Qualified 5%', 'Discovery 25%', 'Technical 50%', 'Commercial 75%', 'Purchasing 90%'];
const STATUS_CHIPS: { key: DrStatus; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'sql', label: 'SQL' },
  { key: 'stale', label: 'Stale' },
  { key: 'padded', label: 'Padded' },
  { key: 'converted', label: 'Converted' },
  { key: 'closed_won', label: 'Closed Won' },
  { key: 'closed_lost', label: 'Closed Lost' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'withdrawn', label: 'Withdrawn' },
];
const DEFAULT_STATUSES: DrStatus[] = ['active', 'sql', 'stale', 'padded', 'converted', 'closed_won', 'closed_lost'];

type Period = 'this-month' | 'last-month' | 'this-quarter' | 'last-quarter' | 'all';
const DEFAULT_PERIOD: Period = 'this-quarter';

function fmtMoney(n: number): string {
  if (!n) return '$0';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
function fmtDollar(n: number): string {
  return `$${Math.round(n || 0).toLocaleString()}`;
}
function fmtPct(n: number, digits = 0): string { return `${(n * 100).toFixed(digits)}%`; }

// Pipeline DR = SQL'd, amount > 0, still open
function isPipelineDr(d: DealRegistration): boolean {
  return !!d.isSql && (d.amount ?? 0) > 0 &&
    d.status !== 'closed_won' && d.status !== 'closed_lost' &&
    d.status !== 'rejected' && d.status !== 'withdrawn';
}
function pipelineSum(deals: DealRegistration[]): number {
  return deals.filter(isPipelineDr).reduce((s, d) => s + (d.amount || 0), 0);
}
function closedWonSum(deals: DealRegistration[], oppMap?: Map<string, Opportunity>): number {
  return deals.filter(d => d.status === 'closed_won').reduce((s, d) => {
    const amt = (d.amount ?? null) !== null && (d.amount ?? 0) > 0
      ? (d.amount as number)
      : (oppMap?.get(d.opportunityId)?.amount ?? 0);
    return s + (amt || 0);
  }, 0);
}

function normalizeStage(s: string): string {
  const low = (s || '').toLowerCase();
  for (const st of STAGE_ORDER) if (low.includes(st.toLowerCase().split(' ')[0])) return st;
  return s || 'Unknown';
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a).getTime(); const db = new Date(b).getTime();
  if (!isFinite(da) || !isFinite(db)) return 0;
  return Math.round((db - da) / 86_400_000);
}

function getPeriodRange(period: Period): { start: Date | null; end: Date | null } {
  if (period === 'all') return { start: null, end: null };
  const now = new Date();
  const y = now.getUTCFullYear(); const m = now.getUTCMonth();
  if (period === 'this-month') {
    return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1) - 1) };
  }
  if (period === 'last-month') {
    return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1) - 1) };
  }
  const qStart = Math.floor(m / 3) * 3;
  if (period === 'this-quarter') {
    return { start: new Date(Date.UTC(y, qStart, 1)), end: new Date(Date.UTC(y, qStart + 3, 1) - 1) };
  }
  // last-quarter
  return { start: new Date(Date.UTC(y, qStart - 3, 1)), end: new Date(Date.UTC(y, qStart, 1) - 1) };
}

function inRange(dateStr: string | undefined, range: { start: Date | null; end: Date | null }): boolean {
  if (!range.start || !range.end) return true;
  if (!dateStr) return false;
  const d = new Date(dateStr).getTime();
  if (!isFinite(d)) return false;
  return d >= range.start.getTime() && d <= range.end.getTime();
}

// Staleness — Active means not yet stale
function isStale(d: DealRegistration): boolean {
  const stage = (d.stage || '').toLowerCase();
  const age = d.ageDays;
  if (stage.includes('unqualified') && age > 21) return true;
  if (d.probability < 0.1 && age > 30) return true;
  if (d.probability >= 0.25 && age > 45 && !d.lastActivity) return true;
  return false;
}

function statusBadgeCls(s: DrStatus): string {
  switch (s) {
    case 'sql': return 'bg-green-500/15 text-green-700 dark:text-green-400';
    case 'active': return 'bg-blue-500/15 text-blue-700 dark:text-blue-400';
    case 'stale': return 'bg-amber-500/15 text-amber-700 dark:text-amber-400';
    case 'padded': return 'bg-red-500/15 text-red-700 dark:text-red-400';
    case 'converted': return 'bg-teal-500/15 text-teal-700 dark:text-teal-400';
    case 'closed_won': return 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 font-semibold';
    case 'closed_lost': return 'bg-red-500/10 text-red-700/70 dark:text-red-400/70';
    case 'rejected': return 'bg-foreground/15 text-foreground/80';
    case 'withdrawn': return 'bg-muted text-muted-foreground';
  }
}
function statusLabel(s: DrStatus): string {
  return STATUS_CHIPS.find(c => c.key === s)?.label || s;
}

// Sort priority for default sort
const STATUS_SORT_PRIORITY: Record<DrStatus, number> = {
  stale: 0, padded: 1, active: 2, sql: 3, converted: 4, closed_won: 5, closed_lost: 6, rejected: 7, withdrawn: 8,
};

// ---------- Upload zone ----------
function UploadZone({ onParsed }: {
  onParsed: (records: RawDrRecord[], asOfDate: string, fileName: string, errors: string[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [parsing, setParsing] = useState(false);
  const { toast } = useToast();

  const handleFile = useCallback(async (file: File) => {
    setParsing(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', cellDates: false });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: '' });
      const { records, asOfDate, errors } = parseDrExport(rows, ws);
      if (records.length === 0) {
        toast({ title: 'No records found', description: errors[0] || 'File appears empty.', variant: 'destructive' });
        setParsing(false);
        return;
      }
      onParsed(records, asOfDate, file.name, errors);
    } catch (err: any) {
      toast({ title: 'Parse error', description: err?.message || 'Could not read file.', variant: 'destructive' });
    } finally {
      setParsing(false);
    }
  }, [onParsed, toast]);

  return (
    <div
      onDragOver={e => e.preventDefault()}
      onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
      onClick={() => inputRef.current?.click()}
      className="border-2 border-dashed border-border rounded-lg p-8 text-center cursor-pointer hover:border-foreground/30 transition-colors"
    >
      <Upload size={24} className="mx-auto mb-2 text-muted-foreground" />
      <p className="text-sm font-medium">Upload Salesforce DR Report</p>
      <p className="text-xs text-muted-foreground mt-1">Each upload merges into your DR history — lifecycle is preserved.</p>
      <p className="text-xs text-muted-foreground mt-1">For best results, re-import your main pipeline report before uploading the DR report to ensure deal matching is current.</p>
      {parsing && <p className="text-xs text-muted-foreground mt-2">Parsing…</p>}
      <input ref={inputRef} type="file" accept=".xlsx" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); if (inputRef.current) inputRef.current.value = ''; }}
      />
    </div>
  );
}

// ---------- Stage history timeline ----------
function StageTimeline({ d }: { d: DealRegistration }) {
  if (!d.stageHistory || d.stageHistory.length === 0) {
    return <p className="text-xs text-muted-foreground">No stage history yet.</p>;
  }
  const parts: string[] = [`Created (Day 0)`];
  for (const h of d.stageHistory) {
    const day = daysBetween(d.createdDate, h.date);
    parts.push(`${h.stage} (Day ${day})`);
  }
  return <p className="text-xs"><span className="text-muted-foreground">Stage history: </span>{parts.join(' → ')}</p>;
}

// ---------- Main ----------
export default function DrPipeline() {
  const { dealRegistrations, drBatches, opportunities, reps, importDrBatch, clearDrData } = useForecast();
  const { toast } = useToast();

  const [showUploader, setShowUploader] = useState(false);
  const [pending, setPending] = useState<{
    records: RawDrRecord[]; asOfDate: string; fileName: string; errors: string[];
    preview: { newCount: number; updatedCount: number; rejectedCount: number; withdrawnCount: number; convertedCount: number };
  } | null>(null);

  // Global filters
  const [camFilter, setCamFilter] = useState<string>('all');
  const [repFilter, setRepFilter] = useState<string>('all');
  const [period, setPeriod] = useState<Period>(DEFAULT_PERIOD);
  const [timelinePeriod, setTimelinePeriod] = useState<Period>('all');
  const [statuses, setStatuses] = useState<Set<DrStatus>>(() => new Set(DEFAULT_STATUSES));

  // Detail table
  const [sortKey, setSortKey] = useState<string>('default');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  // Section B
  const [expandedRep, setExpandedRep] = useState<string | null>(null);

  // Section C
  const [showCam, setShowCam] = useState(false);

  // Section D
  const [funnelMonthOffset, setFunnelMonthOffset] = useState(0);

  // Deal Quality Analysis collapsible
  const [qualityExpanded, setQualityExpanded] = useState(true);
  const [dqView, setDqView] = useState<'defensible' | 'all'>('defensible');

  // Section F
  const [showPaddedOnly, setShowPaddedOnly] = useState(false);

  // AE accountability: hide inactive reps by default
  const [showInactiveReps, setShowInactiveReps] = useState(false);
  const inactiveRepNameSet = useMemo(
    () => new Set(reps.filter(r => r.isActive === false).map(r => r.name)),
    [reps]
  );

  const allCams = useMemo(() => {
    const set = new Set<string>();
    for (const d of dealRegistrations) set.add(d.channelAccountManager || '(none)');
    return Array.from(set).sort();
  }, [dealRegistrations]);

  const allReps = useMemo(() => {
    const set = new Set<string>();
    for (const d of dealRegistrations) if (d.repName) set.add(d.repName);
    return Array.from(set).sort();
  }, [dealRegistrations]);

  // ---------- Apply filters ----------
  const periodRange = useMemo(() => getPeriodRange(period), [period]);
  const timelineRange = useMemo(() => getPeriodRange(timelinePeriod), [timelinePeriod]);

  // Padded account membership — opportunityIds belonging to multi-DR accounts
  // where every DR is pre-SQL with no activity (matches Section F "Padded = Yes")
  const paddedOpportunityIds = useMemo(() => {
    const set = new Set<string>();
    const base = dealRegistrations.filter(d => {
      if (d.status === 'rejected') return false;
      if (camFilter !== 'all' && (d.channelAccountManager || '(none)') !== camFilter) return false;
      if (repFilter !== 'all' && d.repName !== repFilter) return false;
      if (!inRange(d.createdDate, periodRange)) return false;
      return true;
    });
    const byAcct = new Map<string, DealRegistration[]>();
    for (const d of base) {
      const a = d.accountName || '(none)';
      const arr = byAcct.get(a) || []; arr.push(d); byAcct.set(a, arr);
    }
    for (const arr of byAcct.values()) {
      if (arr.length < 2) continue;
      if (arr.every(d => !d.isSql && !d.lastActivity)) {
        for (const d of arr) set.add(d.opportunityId);
      }
    }
    return set;
  }, [dealRegistrations, camFilter, repFilter, periodRange]);

  // Globally padded opportunityIds (no filter scope) for use in cohort table
  const paddedOpportunityIdsAll = useMemo(() => {
    const set = new Set<string>();
    const base = dealRegistrations.filter(d => d.status !== 'rejected');
    const byAcct = new Map<string, DealRegistration[]>();
    for (const d of base) {
      const a = d.accountName || '(none)';
      const arr = byAcct.get(a) || [];
      arr.push(d);
      byAcct.set(a, arr);
    }
    for (const arr of byAcct.values()) {
      if (arr.length < 2) continue;
      if (arr.every(d => !d.isSql && !d.lastActivity)) {
        for (const d of arr) set.add(d.opportunityId);
      }
    }
    return set;
  }, [dealRegistrations]);

  const filtered = useMemo(() => {
    return dealRegistrations.filter(d => {
      if (camFilter !== 'all' && (d.channelAccountManager || '(none)') !== camFilter) return false;
      if (repFilter !== 'all' && d.repName !== repFilter) return false;
      if (!inRange(d.createdDate, periodRange)) return false;
      if (statuses.size > 0) {
        const directMatch = statuses.has(d.status);
        const paddedMatch = (statuses as Set<string>).has('padded') && paddedOpportunityIds.has(d.opportunityId);
        if (!directMatch && !paddedMatch) return false;
      }
      return true;
    });
  }, [dealRegistrations, camFilter, repFilter, periodRange, statuses, paddedOpportunityIds]);


  const timelineFiltered = useMemo(() => {
    return dealRegistrations.filter(d => {
      if (camFilter !== 'all' && (d.channelAccountManager || '(none)') !== camFilter) return false;
      if (repFilter !== 'all' && d.repName !== repFilter) return false;
      if (!inRange(d.createdDate, timelineRange)) return false;
      if (statuses.size > 0 && !statuses.has(d.status)) return false;
      return true;
    });
  }, [dealRegistrations, camFilter, repFilter, timelineRange, statuses]);

  // Section-B "scope" ignores statuses (so all rows show) but applies cam/rep/period
  const scopeNoStatus = useMemo(() => {
    return dealRegistrations.filter(d => {
      if (camFilter !== 'all' && (d.channelAccountManager || '(none)') !== camFilter) return false;
      if (repFilter !== 'all' && d.repName !== repFilter) return false;
      if (!inRange(d.createdDate, periodRange)) return false;
      return true;
    });
  }, [dealRegistrations, camFilter, repFilter, periodRange]);

  const oppMap = useMemo(() => new Map(opportunities.map(o => [o.id, o])), [opportunities]);

  const defaultStatusesActive = DEFAULT_STATUSES.length === statuses.size && DEFAULT_STATUSES.every(s => statuses.has(s));
  const filtersActive = camFilter !== 'all' || repFilter !== 'all' || period !== DEFAULT_PERIOD || !defaultStatusesActive;
  const clearFilters = () => { setCamFilter('all'); setRepFilter('all'); setPeriod(DEFAULT_PERIOD); setStatuses(new Set(DEFAULT_STATUSES)); };

  // ---------- Cohort helpers (per-rep / per-cam vintage table) ----------
  type CohortRow = {
    quarter: string; total: number; sql: number; closedWon: number;
    cohortRate: number; avgCycle: number | null;
  };
  function buildCohortRows(deals: DealRegistration[]): CohortRow[] {
    const byQ = new Map<string, DealRegistration[]>();
    for (const d of deals) {
      if (!d.createdDate) continue;
      // Inline quarter calc to avoid importing — matches getQuarter shape "YYYY-QN"
      const dd = new Date(d.createdDate);
      const y = dd.getUTCFullYear();
      const q = Math.floor(dd.getUTCMonth() / 3) + 1;
      const key = `${y}-Q${q}`;
      const arr = byQ.get(key) || []; arr.push(d); byQ.set(key, arr);
    }
    const rows: CohortRow[] = Array.from(byQ.entries()).map(([quarter, arr]) => {
      const total = arr.length;
      const sql = arr.filter(d => d.isSql || d.sqlDate).length;
      const wonDeals = arr.filter(d => d.status === 'closed_won');
      const closedWon = wonDeals.length;
      const cohortRate = total ? closedWon / total : 0;
      const cycles = wonDeals.map(d => d.cycleDays).filter((n): n is number => typeof n === 'number');
      const avgCycle = cycles.length ? cycles.reduce((s, n) => s + n, 0) / cycles.length : null;
      return { quarter, total, sql, closedWon, cohortRate, avgCycle };
    });
    rows.sort((a, b) => a.quarter.localeCompare(b.quarter));
    return rows;
  }

  // ---------- Section B: AE Accountability ----------
  type AeRow = {
    rep: string; assigned: number; rejected: number; sqls: number; sqlRate: number;
    stale: number; noActivity: number; unworked: number; unworkedPct: number; avgAge: number;
    converted: number; closedWon: number; convRate: number;
    cohortRate: number; avgCycle: number | null;
    pipelineAmount: number; closedWonAmount: number;
    rejectedByCam: Map<string, { count: number; products: string[] }>;
    cohort: CohortRow[];
  };

  const aeRows: AeRow[] = useMemo(() => {
    const byRep = new Map<string, DealRegistration[]>();
    for (const d of scopeNoStatus) {
      const k = d.repName || '(unassigned)';
      const arr = byRep.get(k) || [];
      arr.push(d);
      byRep.set(k, arr);
    }
    const rows: AeRow[] = Array.from(byRep.entries()).map(([rep, deals]) => {
      const assigned = deals.length;
      const rejected = deals.filter(d => d.status === 'rejected').length;
      const nonRejected = deals.filter(d => d.status !== 'rejected');
      const denom = nonRejected.length;
      const sqls = nonRejected.filter(everReachedSql).length;
      const sqlRate = denom ? sqls / denom : 0;
      const stale = nonRejected.filter(d => d.status === 'stale').length;
      const noActivity = nonRejected.filter(d => !d.lastActivity && (d.status === 'active' || d.status === 'stale')).length;
      // Unworked = non-terminal, not currentlySql, no lastActivity, createdDate > 15 days ago.
      const today = new Date();
      const nonTerminal = deals.filter(d =>
        d.status !== 'rejected' && d.status !== 'closed_won' && d.status !== 'closed_lost' && d.status !== 'withdrawn'
      );
      const unworked = nonTerminal.filter(d =>
        !currentlySql(d) && !d.lastActivity && daysSinceActivity(d, today) > 15
      ).length;
      const unworkedPct = nonTerminal.length ? unworked / nonTerminal.length : 0;
      const avgAge = denom ? nonRejected.reduce((s, d) => s + d.ageDays, 0) / denom : 0;
      const converted = nonRejected.filter(d => d.status === 'converted' || d.status === 'closed_won' || d.status === 'closed_lost').length;
      const wonDeals = nonRejected.filter(d => d.status === 'closed_won');
      const closedWon = wonDeals.length;
      const convRate = denom ? closedWon / denom : 0;
      const cohortRate = denom ? closedWon / denom : 0;
      const cycles = wonDeals.map(d => d.cycleDays).filter((n): n is number => typeof n === 'number');
      const avgCycle = cycles.length >= 2 ? cycles.reduce((s, n) => s + n, 0) / cycles.length : null;
      const rejectedByCam = new Map<string, { count: number; products: string[] }>();
      for (const d of deals) {
        if (d.status !== 'rejected') continue;
        const cam = d.channelAccountManager || '(none)';
        const e = rejectedByCam.get(cam) || { count: 0, products: [] };
        e.count++;
        if (d.product && !e.products.includes(d.product)) e.products.push(d.product);
        rejectedByCam.set(cam, e);
      }
      const cohort = buildCohortRows(nonRejected);
      const pipelineAmount = pipelineSum(nonRejected);
      const closedWonAmount = closedWonSum(nonRejected, oppMap);
      return { rep, assigned, rejected, sqls, sqlRate, stale, noActivity, unworked, unworkedPct, avgAge, converted, closedWon, convRate, cohortRate, avgCycle, pipelineAmount, closedWonAmount, rejectedByCam, cohort };
    });
    rows.sort((a, b) => b.assigned - a.assigned);
    if (!showInactiveReps) {
      return rows.filter(r => !inactiveRepNameSet.has(r.rep));
    }
    return rows;
  }, [scopeNoStatus, showInactiveReps, inactiveRepNameSet]);

  const hiddenInactiveCount = useMemo(() => {
    if (showInactiveReps) return 0;
    const reps = new Set<string>();
    for (const d of scopeNoStatus) {
      if (d.repName && inactiveRepNameSet.has(d.repName)) reps.add(d.repName);
    }
    return reps.size;
  }, [scopeNoStatus, showInactiveReps, inactiveRepNameSet]);

  const aeTotals = useMemo(() => {
    const t = aeRows.reduce((acc, r) => {
      const nonRej = r.assigned - r.rejected;
      acc.assigned += r.assigned;
      acc.rejected += r.rejected;
      acc.nonRejected += nonRej;
      acc.sqls += r.sqls; acc.stale += r.stale;
      acc.noActivity += r.noActivity; acc.converted += r.converted; acc.closedWon += r.closedWon;
      acc.ageSum += r.avgAge * nonRej;
      acc.pipelineAmount += r.pipelineAmount;
      acc.closedWonAmount += r.closedWonAmount;
      return acc;
    }, { assigned: 0, rejected: 0, nonRejected: 0, sqls: 0, stale: 0, noActivity: 0, converted: 0, closedWon: 0, ageSum: 0, pipelineAmount: 0, closedWonAmount: 0 });
    return {
      ...t,
      sqlRate: t.nonRejected ? t.sqls / t.nonRejected : 0,
      avgAge: t.nonRejected ? t.ageSum / t.nonRejected : 0,
      convRate: t.nonRejected ? t.closedWon / t.nonRejected : 0,
    };
  }, [aeRows]);

  const aeInsights = useMemo(() => {
    const lines: string[] = [];
    for (const r of aeRows) {
      if (r.noActivity > 3) lines.push(`⚠ ${r.rep} has ${r.noActivity} DRs with no activity logged — follow up in next 1:1.`);
      if (r.stale > 0) {
        const avgStaleAge = r.avgAge.toFixed(0);
        lines.push(`⚠ ${r.rep} has ${r.stale} stale DRs averaging ${avgStaleAge} days old.`);
      }
      if (r.convRate >= 0.2 && r.convRate > aeTotals.convRate) {
        lines.push(`✓ ${r.rep} is converting at ${fmtPct(r.convRate, 1)} — above team average.`);
      }
    }
    return lines;
  }, [aeRows, aeTotals.convRate]);

  // ---------- Section C: CAM Cohort & Cycle ----------
  type CamRow = {
    cam: string; totalDrs: number; sqls: number; sqlRate: number;
    closedWon: number; cohortRate: number;
    pipelineAmount: number; closedWonAmount: number;
    avgCycle: number | null; fastest: number | null; slowest: number | null;
    inPeriodWon: number; withdrawn: number; withdrawnRate: number;
    cohort: CohortRow[];
  };

  const [camSortKey, setCamSortKey] = useState<keyof CamRow>('cohortRate');
  const [camSortDir, setCamSortDir] = useState<'asc' | 'desc'>('desc');
  const [expandedCam, setExpandedCam] = useState<string | null>(null);

  const camRows: CamRow[] = useMemo(() => {
    const byCam = new Map<string, DealRegistration[]>();
    for (const d of scopeNoStatus) {
      if (d.status === 'rejected') continue; // CAM table excludes rejected (AE action)
      const k = d.channelAccountManager || '(none)';
      const arr = byCam.get(k) || [];
      arr.push(d);
      byCam.set(k, arr);
    }
    const rows = Array.from(byCam.entries()).map(([cam, deals]) => {
      const totalDrs = deals.length;
      const sqls = deals.filter(d => d.isSql).length;
      const sqlRate = totalDrs ? sqls / totalDrs : 0;
      const wonDeals = deals.filter(d => d.status === 'closed_won');
      const closedWon = wonDeals.length;
      const cohortRate = totalDrs ? closedWon / totalDrs : 0;
      const cycles = wonDeals.map(d => d.cycleDays).filter((n): n is number => typeof n === 'number');
      const avgCycle = cycles.length >= 2 ? cycles.reduce((s, n) => s + n, 0) / cycles.length : null;
      const fastest = cycles.length ? Math.min(...cycles) : null;
      const slowest = cycles.length ? Math.max(...cycles) : null;
      const inPeriodWon = wonDeals.filter(d => d.inPeriodWon === true).length;
      const withdrawn = deals.filter(d => d.status === 'withdrawn').length;
      const withdrawnRate = totalDrs ? withdrawn / totalDrs : 0;
      const pipelineAmount = pipelineSum(deals);
      const closedWonAmount = closedWonSum(deals, oppMap);
      const cohort = buildCohortRows(deals);
      return { cam, totalDrs, sqls, sqlRate, closedWon, cohortRate, pipelineAmount, closedWonAmount, avgCycle, fastest, slowest, inPeriodWon, withdrawn, withdrawnRate, cohort };
    });
    rows.sort((a, b) => {
      const dir = camSortDir === 'asc' ? 1 : -1;
      const av = a[camSortKey] as any; const bv = b[camSortKey] as any;
      if (typeof av === 'string') return av.localeCompare(bv) * dir;
      return ((av ?? -1) - (bv ?? -1)) * dir;
    });
    return rows;
  }, [scopeNoStatus, camSortKey, camSortDir, oppMap]);

  const camTotals = useMemo(() => {
    const t = camRows.reduce((acc, r) => {
      acc.totalDrs += r.totalDrs;
      acc.sqls += r.sqls;
      acc.closedWon += r.closedWon;
      acc.inPeriodWon += r.inPeriodWon;
      acc.withdrawn += r.withdrawn;
      acc.pipelineAmount += r.pipelineAmount;
      acc.closedWonAmount += r.closedWonAmount;
      if (r.avgCycle !== null) { acc.cycleSum += r.avgCycle * r.closedWon; acc.cycleN += r.closedWon; }
      return acc;
    }, { totalDrs: 0, sqls: 0, closedWon: 0, inPeriodWon: 0, withdrawn: 0, cycleSum: 0, cycleN: 0, pipelineAmount: 0, closedWonAmount: 0 });
    return {
      ...t,
      sqlRate: t.totalDrs ? t.sqls / t.totalDrs : 0,
      cohortRate: t.totalDrs ? t.closedWon / t.totalDrs : 0,
      avgCycle: t.cycleN ? t.cycleSum / t.cycleN : null,
      withdrawnRate: t.totalDrs ? t.withdrawn / t.totalDrs : 0,
    };
  }, [camRows]);

  const camInsights = useMemo(() => {
    const out: string[] = [];
    for (const r of camRows) {
      if (r.cohortRate < 0.1 && r.totalDrs > 10) {
        out.push(`⚠ ${r.cam} has registered ${r.totalDrs} DRs with only ${fmtPct(r.cohortRate, 0)} ever closing — review lead quality in next QBR.`);
      }
      if (r.avgCycle !== null && r.avgCycle > 180 && r.closedWon > 2) {
        out.push(`⚠ ${r.cam}'s leads average ${r.avgCycle.toFixed(0)} days to close — long cycles may indicate lead quality or territory fit issues.`);
      }
      if (r.withdrawnRate > 0.4) {
        out.push(`⚠ ${r.cam} has ${fmtPct(r.withdrawnRate, 0)} of registrations withdrawn — partner may not be actively supporting these leads.`);
      }
      if (r.fastest !== null && r.fastest < 30 && r.closedWon > 2) {
        out.push(`✓ ${r.cam} is generating fast-moving deals — fastest close is ${r.fastest} days.`);
      }
      if (r.closedWonAmount > 150_000) {
        out.push(`✓ ${r.cam} has delivered ${fmtDollar(r.closedWonAmount)} in closed won revenue.`);
      }
      if (r.pipelineAmount > 300_000 && r.cohortRate < 0.05) {
        out.push(`⚠ ${r.cam} has ${fmtDollar(r.pipelineAmount)} in qualified pipeline with ${fmtPct(r.cohortRate, 0)} historical close rate.`);
      }
    }
    return out;
  }, [camRows]);

  // ---------- Section C2: Reseller Performance ----------
  type PaddedAccountRow = { account: string; drs: number; preSqlNoActivity: number; products: string[] };
  type ResellerRow = {
    reseller: string;
    totalDrs: number;
    sqls: number;
    sqlRate: number;
    closedWon: number;
    cohortRate: number;
    pipelineAmount: number;
    closedWonAmount: number;
    avgCycle: number | null;
    fastest: number | null;
    slowest: number | null;
    activeReps: number;
    topCam: string;
    paddedAccts: number;
    paddingRate: number;
    paddedAccountsList: PaddedAccountRow[];
    cohort: CohortRow[];
    repBreakdown: { rep: string; drs: number; sqls: number; closedWon: number; cohortRate: number }[];
    camBreakdown: { cam: string; drs: number; sqls: number; closedWon: number; cohortRate: number }[];
  };

  const [showReseller, setShowReseller] = useState(false);
  const [resellerSortKey, setResellerSortKey] = useState<keyof ResellerRow>('cohortRate');
  const [resellerSortDir, setResellerSortDir] = useState<'asc' | 'desc'>('desc');
  const [expandedReseller, setExpandedReseller] = useState<string | null>(null);

  const resellerRows: ResellerRow[] = useMemo(() => {
    const byReseller = new Map<string, DealRegistration[]>();
    for (const d of scopeNoStatus) {
      if (d.status === 'rejected') continue;
      const name = d.resolvedReseller?.trim();
      if (!name) continue;
      const arr = byReseller.get(name) || [];
      arr.push(d);
      byReseller.set(name, arr);
    }
    const rows: ResellerRow[] = [];
    for (const [reseller, deals] of byReseller.entries()) {
      const totalDrs = deals.length;
      if (totalDrs < 3) continue;
      const sqls = deals.filter(d => d.isSql).length;
      const sqlRate = totalDrs ? sqls / totalDrs : 0;
      const wonDeals = deals.filter(d => d.status === 'closed_won');
      const closedWon = wonDeals.length;
      const cohortRate = totalDrs ? closedWon / totalDrs : 0;
      const cycles = wonDeals.map(d => d.cycleDays).filter((n): n is number => typeof n === 'number');
      const avgCycle = cycles.length >= 2 ? cycles.reduce((s, n) => s + n, 0) / cycles.length : null;
      const fastest = cycles.length ? Math.min(...cycles) : null;
      const slowest = cycles.length ? Math.max(...cycles) : null;
      const repSet = new Set(deals.map(d => d.repName).filter(Boolean));
      const activeReps = repSet.size;
      const camCounts = new Map<string, number>();
      for (const d of deals) {
        const c = d.channelAccountManager || '(none)';
        camCounts.set(c, (camCounts.get(c) || 0) + 1);
      }
      const topCam = [...camCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '—';

      const breakdown = (group: Map<string, DealRegistration[]>) =>
        [...group.entries()].map(([key, arr]) => {
          const t = arr.length;
          const s = arr.filter(d => d.isSql).length;
          const w = arr.filter(d => d.status === 'closed_won').length;
          return { key, drs: t, sqls: s, closedWon: w, cohortRate: t ? w / t : 0 };
        }).sort((a, b) => b.drs - a.drs);

      const repMap = new Map<string, DealRegistration[]>();
      const camMap = new Map<string, DealRegistration[]>();
      for (const d of deals) {
        const r = d.repName || '(unassigned)';
        const c = d.channelAccountManager || '(none)';
        const ra = repMap.get(r) || []; ra.push(d); repMap.set(r, ra);
        const ca = camMap.get(c) || []; ca.push(d); camMap.set(c, ca);
      }
      const repBreakdown = breakdown(repMap).map(({ key, ...rest }) => ({ rep: key, ...rest }));
      const camBreakdown = breakdown(camMap).map(({ key, ...rest }) => ({ cam: key, ...rest }));
      const cohort = buildCohortRows(deals);

      // Padding analysis: group reseller's DRs by account, find accounts with 2+ pre-SQL no-activity DRs.
      // pre-SQL no-activity = !isSql, lastActivity === null, status not in (rejected, closed_won, closed_lost, withdrawn).
      const isPreSqlNoActivity = (d: DealRegistration) =>
        !d.isSql && !d.lastActivity &&
        d.status !== 'rejected' && d.status !== 'closed_won' && d.status !== 'closed_lost' && d.status !== 'withdrawn';
      const byAcct = new Map<string, DealRegistration[]>();
      for (const d of deals) {
        const a = d.accountName || '(none)';
        const arr = byAcct.get(a) || []; arr.push(d); byAcct.set(a, arr);
      }
      const paddedAccountsList: PaddedAccountRow[] = [];
      let paddingDrCount = 0;
      for (const [account, arr] of byAcct.entries()) {
        const preSqlNoActivity = arr.filter(isPreSqlNoActivity).length;
        if (preSqlNoActivity >= 2) {
          const products = Array.from(new Set(arr.map(d => d.product).filter(Boolean))) as string[];
          paddedAccountsList.push({ account, drs: arr.length, preSqlNoActivity, products });
          paddingDrCount += preSqlNoActivity;
        }
      }
      paddedAccountsList.sort((a, b) => b.preSqlNoActivity - a.preSqlNoActivity);
      const paddedAccts = paddedAccountsList.length;
      const paddingRate = totalDrs ? paddingDrCount / totalDrs : 0;

      const pipelineAmount = pipelineSum(deals);
      const closedWonAmount = closedWonSum(deals, oppMap);

      rows.push({ reseller, totalDrs, sqls, sqlRate, closedWon, cohortRate, pipelineAmount, closedWonAmount, avgCycle, fastest, slowest, activeReps, topCam, paddedAccts, paddingRate, paddedAccountsList, cohort, repBreakdown, camBreakdown });
    }
    rows.sort((a, b) => {
      const dir = resellerSortDir === 'asc' ? 1 : -1;
      const av = a[resellerSortKey] as any; const bv = b[resellerSortKey] as any;
      if (typeof av === 'string') return av.localeCompare(bv) * dir;
      return ((av ?? -1) - (bv ?? -1)) * dir;
    });
    return rows;
  }, [scopeNoStatus, resellerSortKey, resellerSortDir, oppMap]);

  const resellerTotals = useMemo(() => {
    const t = resellerRows.reduce((acc, r) => {
      acc.totalDrs += r.totalDrs;
      acc.sqls += r.sqls;
      acc.closedWon += r.closedWon;
      acc.paddedAccts += r.paddedAccts;
      acc.paddingDrs += r.paddingRate * r.totalDrs;
      acc.pipelineAmount += r.pipelineAmount;
      acc.closedWonAmount += r.closedWonAmount;
      if (r.avgCycle !== null) { acc.cycleSum += r.avgCycle * r.closedWon; acc.cycleN += r.closedWon; }
      return acc;
    }, { totalDrs: 0, sqls: 0, closedWon: 0, cycleSum: 0, cycleN: 0, paddedAccts: 0, paddingDrs: 0, pipelineAmount: 0, closedWonAmount: 0 });
    return {
      ...t,
      sqlRate: t.totalDrs ? t.sqls / t.totalDrs : 0,
      cohortRate: t.totalDrs ? t.closedWon / t.totalDrs : 0,
      avgCycle: t.cycleN ? t.cycleSum / t.cycleN : null,
      paddingRate: t.totalDrs ? t.paddingDrs / t.totalDrs : 0,
    };
  }, [resellerRows]);

  const resellerInsights = useMemo(() => {
    const out: string[] = [];
    for (const r of resellerRows) {
      if (r.cohortRate >= 0.2 && r.totalDrs >= 10) {
        out.push(`✓ ${r.reseller} is your highest-converting partner at ${fmtPct(r.cohortRate, 0)} cohort rate — prioritize their leads.`);
      }
      if (r.totalDrs >= 20 && r.cohortRate < 0.05) {
        out.push(`⚠ ${r.reseller} has registered ${r.totalDrs} DRs with only ${fmtPct(r.cohortRate, 0)} closing — review lead quality with this partner.`);
      }
      if (r.avgCycle !== null && r.avgCycle > 180 && r.closedWon >= 2) {
        out.push(`⚠ ${r.reseller}'s deals average ${r.avgCycle.toFixed(0)} days to close — factor into pipeline timing.`);
      }
      if (r.paddingRate >= 0.2 && r.totalDrs >= 10) {
        out.push(`⚠ ${r.reseller} has ${fmtPct(r.paddingRate, 0)} of registrations showing padding patterns (${r.paddedAccts} accounts with multiple pre-SQL, no-activity DRs) — raise in next QBR.`);
      }
      if (r.closedWonAmount > 200_000) {
        out.push(`✓ ${r.reseller} has delivered ${fmtDollar(r.closedWonAmount)} in closed won revenue — your highest-value partner.`);
      }
      if (r.pipelineAmount > 500_000 && r.cohortRate < 0.05) {
        out.push(`⚠ ${r.reseller} has ${fmtDollar(r.pipelineAmount)} in qualified pipeline but only ${fmtPct(r.cohortRate, 0)} historical close rate — treat pipeline value with caution.`);
      }
    }
    return out;
  }, [resellerRows]);


  // ---------- Section D: Funnel + Conversion timeline + Cohort ----------
  const funnelMonthDate = useMemo(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + funnelMonthOffset, 1));
  }, [funnelMonthOffset]);
  const funnelMonthLabel = funnelMonthDate.toLocaleString('default', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  // Funnel uses period filter, not month override unless user navigates
  const funnelDeals = useMemo(() => {
    if (funnelMonthOffset === 0) return filtered;
    const start = funnelMonthDate;
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1) - 1);
    return dealRegistrations.filter(d => {
      if (!d.createdDate) return false;
      const t = new Date(d.createdDate).getTime();
      return t >= start.getTime() && t <= end.getTime();
    });
  }, [filtered, funnelMonthOffset, funnelMonthDate, dealRegistrations]);

  const stageRows = useMemo(() => {
    const total = funnelDeals.length || 1;
    const byStage = new Map<string, number>();
    for (const d of funnelDeals) {
      const s = normalizeStage(d.stage);
      byStage.set(s, (byStage.get(s) || 0) + 1);
    }
    return STAGE_ORDER.map(stage => ({ stage, count: byStage.get(stage) || 0, pct: (byStage.get(stage) || 0) / total }));
  }, [funnelDeals]);

  // Conversion timeline
  const timeline = useMemo(() => {
    const oppMap = new Map(opportunities.map(o => [o.id, o]));
    const toSql = timelineFiltered.filter(d => d.sqlDate && d.createdDate).map(d => daysBetween(d.createdDate, d.sqlDate!));
    const toConv = timelineFiltered.filter(d => d.convertedAt && d.createdDate).map(d => daysBetween(d.createdDate, d.convertedAt!));
    const toWon = timelineFiltered.filter(d => d.status === 'closed_won' && d.createdDate)
      .map(d => {
        const opp = oppMap.get(d.opportunityId);
        if (!opp?.closeDate) return null;
        return daysBetween(d.createdDate, opp.closeDate);
      })
      .filter((n): n is number => n !== null);
    const avg = (arr: number[]) => arr.length ? arr.reduce((s, n) => s + n, 0) / arr.length : 0;
    return [
      { label: 'Created → SQL', avg: avg(toSql), n: toSql.length },
      { label: 'Created → Converted to Pipeline', avg: avg(toConv), n: toConv.length },
      { label: 'Created → Closed Won', avg: avg(toWon), n: toWon.length },
    ];
  }, [timelineFiltered, opportunities]);

  const cohortRows = useMemo(() => {
    const now = new Date();
    const months: { label: string; year: number; month: number }[] = [];
    for (let i = 3; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      months.push({ label: d.toLocaleString('default', { month: 'short', year: '2-digit', timeZone: 'UTC' }), year: d.getUTCFullYear(), month: d.getUTCMonth() });
    }
    return months.map(m => {
      const deals = dealRegistrations.filter(d => {
        if (!d.createdDate) return false;
        const dd = new Date(d.createdDate);
        return dd.getUTCFullYear() === m.year && dd.getUTCMonth() === m.month;
      });
      const sql = deals.filter(d => d.isSql || d.sqlDate).length;
      const inPipe = deals.filter(d => d.status === 'converted' || d.status === 'closed_won' || d.status === 'closed_lost').length;
      const wonDeals = deals.filter(d => d.status === 'closed_won');
      const won = wonDeals.length;
      const lost = deals.filter(d => d.status === 'closed_lost').length;
      const cohortRate = deals.length ? won / deals.length : 0;
      const cycles = wonDeals.map(d => d.cycleDays).filter((n): n is number => typeof n === 'number');
      const avgCycle = cycles.length ? cycles.reduce((s, n) => s + n, 0) / cycles.length : null;
      const rejected = deals.filter(d => d.status === 'rejected').length;
      const withdrawn = deals.filter(d => d.status === 'withdrawn').length;
      // Active = still in flight: total minus closed/rejected/withdrawn
      const active = deals.length - won - lost - rejected - withdrawn;
      // Padded = DRs whose account is padded (Section F definition)
      const padded = deals.filter(d => paddedOpportunityIdsAll.has(d.opportunityId)).length;
      return { month: m.label, total: deals.length, sql, inPipe, won, lost, cohortRate, avgCycle, active, rejected, withdrawn, padded };
    });
  }, [dealRegistrations, paddedOpportunityIdsAll]);

  // ---------- Section E: Detail table ----------


  const detailRows = useMemo(() => {
    let rows = filtered.slice();
    if (expandedRep) rows = rows.filter(r => r.repName === expandedRep);
    rows.sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      if (sortKey === 'default') {
        const ap = STATUS_SORT_PRIORITY[a.status] ?? 99;
        const bp = STATUS_SORT_PRIORITY[b.status] ?? 99;
        if (ap !== bp) return ap - bp;
        return b.ageDays - a.ageDays;
      }
      let av: any, bv: any;
      switch (sortKey) {
        case 'account': av = a.accountName; bv = b.accountName; break;
        case 'opportunity': av = a.opportunityName; bv = b.opportunityName; break;
        case 'rep': av = a.repName; bv = b.repName; break;
        case 'cam': av = a.channelAccountManager || ''; bv = b.channelAccountManager || ''; break;
        case 'stage': av = a.stage; bv = b.stage; break;
        case 'age': av = a.ageDays; bv = b.ageDays; break;
        case 'lastActivity': av = a.lastActivity || ''; bv = b.lastActivity || ''; break;
        case 'amount': av = a.amount || 0; bv = b.amount || 0; break;
        case 'status': av = STATUS_SORT_PRIORITY[a.status]; bv = STATUS_SORT_PRIORITY[b.status]; break;
        case 'reseller': av = a.resellerName || ''; bv = b.resellerName || ''; break;
        default: av = a.ageDays; bv = b.ageDays;
      }
      if (typeof av === 'string') return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });
    return rows;
  }, [filtered, sortKey, sortDir, expandedRep]);

  // ---------- Section F: Account Padding (excludes rejected DRs) ----------
  const accountRows = useMemo(() => {
    const byAcct = new Map<string, DealRegistration[]>();
    for (const d of filtered) {
      if (d.status === 'rejected') continue;
      const a = d.accountName || '(none)';
      const arr = byAcct.get(a) || []; arr.push(d); byAcct.set(a, arr);
    }
    let rows = Array.from(byAcct.entries()).filter(([_, arr]) => arr.length >= 2).map(([account, arr]) => {
      const cams = Array.from(new Set(arr.map(d => d.channelAccountManager || '(none)')));
      const reps = Array.from(new Set(arr.map(d => d.repName || '(unassigned)')));
      const preSql = arr.filter(d => !d.isSql).length;
      const sql = arr.filter(d => d.isSql).length;
      const padded: 'yes' | 'maybe' | 'no' = arr.every(d => !d.isSql && !d.lastActivity) ? 'yes' : arr.every(d => d.isSql) ? 'no' : 'maybe';
      const products = Array.from(new Set(arr.map(d => d.product).filter(Boolean))) as string[];
      return { account, cams, reps, total: arr.length, preSql, sql, padded, products };
    });
    if (showPaddedOnly) rows = rows.filter(r => r.padded === 'yes');
    rows.sort((a, b) => b.total - a.total);
    return rows;
  }, [filtered, showPaddedOnly]);

  // ---------- Pending preview (dry-run merge) ----------
  const handleParsed = useCallback((records: RawDrRecord[], asOfDate: string, fileName: string, errors: string[]) => {
    const dryId = '__preview__';
    const dryAt = new Date().toISOString();
    const { stats } = mergeDrBatch(dealRegistrations, records, opportunities, dryId, dryAt);
    setPending({ records, asOfDate, fileName, errors, preview: stats });
  }, [dealRegistrations, opportunities]);

  const confirmImport = () => {
    if (!pending) return;
    const importedAt = new Date().toISOString();
    const batchId = `batch_${Date.now()}`;
    const { merged } = mergeDrBatch(dealRegistrations, pending.records, opportunities, batchId, importedAt);
    importDrBatch(pending.records, {
      fileName: pending.fileName,
      asOfDate: pending.asOfDate,
      importedAt,
    });
    setPending(null); setShowUploader(false);
    const oppsWithSfId = opportunities.filter(o => o.salesforceId).length;
    const closedWonMatches = merged.filter(d => d.status === 'closed_won').length;
    toast({
      title: 'DR Import Complete',
      description: `${pending.records.length} records parsed · ${closedWonMatches} closed won matched · ${oppsWithSfId}/${opportunities.length} pipeline opps have Salesforce ID`,
    });
  };

  // ---------- Export ----------
  const exportReport = () => {
    const wb = XLSX.utils.book_new();
    const aeSheet = XLSX.utils.json_to_sheet(aeRows.map(r => ({
      Rep: r.rep, 'Assigned DRs': r.assigned, Rejected: r.rejected, "SQL'd": r.sqls, 'SQL Rate': fmtPct(r.sqlRate, 1),
      Converted: r.converted, 'Closed Won': r.closedWon,
      'Cohort Rate': fmtPct(r.cohortRate, 1),
      'Avg Cycle (d)': r.avgCycle !== null ? r.avgCycle.toFixed(0) : '—',
      Stale: r.stale, 'No Activity': r.noActivity, 'Avg Age': r.avgAge.toFixed(1),
    })));
    XLSX.utils.book_append_sheet(wb, aeSheet, 'AE Summary');

    const camSheet = XLSX.utils.json_to_sheet(camRows.map(r => ({
      CAM: r.cam, 'Total DRs': r.totalDrs, 'SQL Rate': fmtPct(r.sqlRate, 1),
      'Closed Won': r.closedWon, 'Cohort Rate': fmtPct(r.cohortRate, 1),
      'Avg Cycle (d)': r.avgCycle !== null ? r.avgCycle.toFixed(0) : '—',
      'Fastest (d)': r.fastest ?? '—', 'Slowest (d)': r.slowest ?? '—',
      'In-Period Won': r.inPeriodWon,
      Withdrawn: r.withdrawn, 'Withdrawn %': fmtPct(r.withdrawnRate, 1),
    })));
    XLSX.utils.book_append_sheet(wb, camSheet, 'CAM Cohort');

    const cohortSheet = XLSX.utils.json_to_sheet(cohortRows.map(r => ({
      'Month Created': r.month, DRs: r.total, "SQL'd": r.sql, 'In Pipeline': r.inPipe,
      'Closed Won': r.won, 'Still Active': r.active, Rejected: r.rejected,
    })));
    XLSX.utils.book_append_sheet(wb, cohortSheet, 'Cohort Conversion');

    const staleDeals = filtered.filter(d => d.status === 'stale' || !d.lastActivity).sort((a, b) => b.ageDays - a.ageDays);
    const staleSheet = XLSX.utils.json_to_sheet(staleDeals.map(d => ({
      Account: d.accountName, Opportunity: d.opportunityName, Rep: d.repName, CAM: d.channelAccountManager || '',
      Stage: d.stage, Probability: d.probability, Amount: d.amount || 0,
      'Age (days)': d.ageDays, 'Last Activity': d.lastActivity || '', Status: statusLabel(d.status),
    })));
    XLSX.utils.book_append_sheet(wb, staleSheet, 'Stale & No Activity');

    // Sheet 4 — Reseller Performance
    const resellerData: any[] = [
      { Note: "Reseller name normalized from 'Reseller Name' and 'Distributor - Reseller' fields. Partners with fewer than 3 DRs excluded." },
      {},
    ];
    for (const r of resellerRows) {
      resellerData.push({
        Reseller: r.reseller,
        'Total DRs': r.totalDrs,
        'SQL Rate': fmtPct(r.sqlRate, 1),
        'Closed Won': r.closedWon,
        'Cohort Rate': fmtPct(r.cohortRate, 1),
        'Avg Cycle (d)': r.avgCycle !== null ? r.avgCycle.toFixed(0) : '—',
        'Fastest (d)': r.fastest ?? '—',
        'Slowest (d)': r.slowest ?? '—',
        'Active Reps': r.activeReps,
        'Top CAM': r.topCam,
        'Padded Accts': r.paddedAccts,
        'Padding %': fmtPct(r.paddingRate, 1),
      });
    }
    const resellerSheet = XLSX.utils.json_to_sheet(resellerData, { skipHeader: false });
    XLSX.utils.book_append_sheet(wb, resellerSheet, 'Reseller Performance');

    // Sheet 5 — Deal Quality Analysis
    const dqAoa: any[][] = [];
    dqAoa.push(['Deal Quality Analysis']);
    dqAoa.push([]);
    dqAoa.push(['Funnel Summary']);
    dqAoa.push(['Stage', 'Count', '% of Total']);
    const t = dealQuality.total || 1;
    dqAoa.push(['DRs Registered', dealQuality.total, '100%']);
    dqAoa.push(['Reached SQL (25%+)', dealQuality.reachedSQL, fmtPct(dealQuality.reachedSQL / t, 0)]);
    dqAoa.push(['In Pipeline', dealQuality.convertedToPipeline, fmtPct(dealQuality.convertedToPipeline / t, 0)]);
    dqAoa.push(['Closed Won', dealQuality.closedWon, fmtPct(dealQuality.closedWon / t, 0)]);
    dqAoa.push([]);
    dqAoa.push(['Key Metrics']);
    dqAoa.push(['Overall Cohort Rate', fmtPct(dealQuality.overallCohortRate, 1), 'All DRs → Closed Won']);
    dqAoa.push(["Win Rate on SQL'd Deals", fmtPct(dealQuality.winRateOnSQL, 1), "SQL'd DRs → Closed Won"]);
    dqAoa.push(['Lead Quality Gap (pp)', (dealQuality.qualityGap * 100).toFixed(1), 'Difference explained by lead quality']);
    dqAoa.push([]);
    dqAoa.push(['Insight']);
    dqAoa.push([dealQuality.insightText]);
    dqAoa.push([]);
    dqAoa.push(['Stage Mortality']);
    dqAoa.push(['From Stage', 'To Stage', 'Deals', 'Drop-off', 'Avg Days at Stage']);
    for (const m of dealQuality.mortality) {
      dqAoa.push([m.from, m.to, `${m.fromCount} → ${m.toCount}`, m.isTerminal ? '—' : fmtPct(m.dropOff, 0), `${m.avgDays.toFixed(0)}d`]);
    }
    dqAoa.push([]);
    dqAoa.push(['By-CAM Quality Breakdown (min 5 DRs)']);
    dqAoa.push(['CAM', 'DRs', 'SQL Rate', 'Win Rate (on SQL)', 'Quality Gap (pp)', 'Verdict']);
    for (const r of dealQuality.camRowsDQ) {
      dqAoa.push([r.cam, r.drs, fmtPct(r.sqlRate, 1), fmtPct(r.winRateOnSQL, 1), (r.qualityGap * 100).toFixed(1), r.verdict]);
    }
    const dqSheet = XLSX.utils.aoa_to_sheet(dqAoa);
    XLSX.utils.book_append_sheet(wb, dqSheet, 'Deal Quality Analysis');

    XLSX.writeFile(wb, `DR_Pipeline_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };


  // ---------- Deal Quality Analysis ----------
  const MORTALITY_STAGES = ['Unqualified', 'Qualified 5%', 'Discovery 25%', 'Technical 50%', 'Commercial 75%', 'Purchasing 90%', 'Closed Won'] as const;
  const MORTALITY_LABELS = ['Registered', 'Qualified 5%', 'Discovery 25% (SQL)', 'Technical 50%', 'Commercial 75%', 'Purchasing 90%', 'Closed Won'];

  const dealQuality = useMemo(() => {
    const drs = scopeNoStatus;
    const nonRej = drs.filter(d => d.status !== 'rejected');
    const total = nonRej.length;
    // SQL rate: any DR that ever qualified (includes lost-after-qualifying).
    const reachedSQL = nonRej.filter(everReachedSql).length;
    const convertedToPipeline = drs.filter(d => d.status === 'converted' || d.status === 'closed_won' || d.status === 'closed_lost').length;
    const closedWon = drs.filter(d => d.status === 'closed_won').length;

    // Win rate on SQL'd deals: resolved-only (won vs lost) among everReachedSql.
    // null when there are no resolved qualified deals — display layer must guard.
    const resolvedQualified = drs.filter(d => everReachedSql(d) && (d.status === 'closed_won' || d.status === 'closed_lost'));
    const sqlClosedWon = resolvedQualified.filter(d => d.status === 'closed_won').length;
    const sqlResolved = resolvedQualified.length;
    const winRateOnSQL: number | null = sqlResolved > 0 ? sqlClosedWon / sqlResolved : null;

    const overallCohortRate = total > 0 ? closedWon / total : 0;
    const sqlRate = total > 0 ? reachedSQL / total : 0;
    const conversionRate = reachedSQL > 0 ? convertedToPipeline / reachedSQL : 0;
    const closeRate = convertedToPipeline > 0 ? closedWon / convertedToPipeline : 0;

    // Stage mortality
    const stageEligible = drs.filter(d => d.status !== 'rejected' && d.status !== 'withdrawn');
    const getRank = (d: DealRegistration): number => {
      if (d.status === 'closed_won') return 6;
      const ns = normalizeStage(d.stage);
      const idx = (MORTALITY_STAGES as readonly string[]).indexOf(ns);
      return idx >= 0 ? idx : -1;
    };
    const cumCounts = MORTALITY_STAGES.map((_, i) => stageEligible.filter(d => getRank(d) >= i).length);
    const registeredCount = stageEligible.length;

    const avgAgeAtStage = (rank: number): number => {
      const at = stageEligible.filter(d => getRank(d) === rank);
      if (at.length === 0) return 0;
      return at.reduce((s, d) => s + (d.ageDays || 0), 0) / at.length;
    };
    const avgAgeAll = stageEligible.length
      ? stageEligible.reduce((s, d) => s + (d.ageDays || 0), 0) / stageEligible.length
      : 0;

    type MortRow = { from: string; to: string; fromCount: number; toCount: number; dropOff: number; avgDays: number; isGate?: boolean; isTerminal?: boolean };
    const mortality: MortRow[] = [
      { from: 'Registered', to: 'Qualified 5%', fromCount: registeredCount, toCount: cumCounts[1], dropOff: registeredCount > 0 ? (registeredCount - cumCounts[1]) / registeredCount : 0, avgDays: avgAgeAll },
      { from: 'Qualified 5%', to: 'Discovery 25% (SQL)', fromCount: cumCounts[1], toCount: cumCounts[2], dropOff: cumCounts[1] > 0 ? (cumCounts[1] - cumCounts[2]) / cumCounts[1] : 0, avgDays: avgAgeAtStage(1), isGate: true },
      { from: 'Discovery 25%', to: 'Technical 50%', fromCount: cumCounts[2], toCount: cumCounts[3], dropOff: cumCounts[2] > 0 ? (cumCounts[2] - cumCounts[3]) / cumCounts[2] : 0, avgDays: avgAgeAtStage(2) },
      { from: 'Technical 50%', to: 'Commercial 75%', fromCount: cumCounts[3], toCount: cumCounts[4], dropOff: cumCounts[3] > 0 ? (cumCounts[3] - cumCounts[4]) / cumCounts[3] : 0, avgDays: avgAgeAtStage(3) },
      { from: 'Commercial 75%', to: 'Purchasing 90%', fromCount: cumCounts[4], toCount: cumCounts[5], dropOff: cumCounts[4] > 0 ? (cumCounts[4] - cumCounts[5]) / cumCounts[4] : 0, avgDays: avgAgeAtStage(4) },
      { from: 'Purchasing 90%', to: 'Closed Won', fromCount: cumCounts[5], toCount: cumCounts[6], dropOff: cumCounts[5] > 0 ? (cumCounts[5] - cumCounts[6]) / cumCounts[5] : 0, avgDays: avgAgeAtStage(5), isTerminal: true },
    ];

    // Insight statement
    const MIN_RESOLVED = 10;
    const hasWinRate = winRateOnSQL !== null && sqlResolved >= MIN_RESOLVED;
    const wr = winRateOnSQL ?? 0;
    const qualityGap = hasWinRate ? wr - overallCohortRate : 0;
    let insightText: string;
    if (winRateOnSQL === null) {
      insightText = `Building history (n=0 resolved) — no SQL'd deals have closed yet. Win rate on SQL'd deals needs more import cycles before it is reliable.`;
    } else if (sqlResolved < MIN_RESOLVED) {
      insightText = `Building history (n=${sqlResolved} resolved) — win rate on SQL'd deals needs at least ${MIN_RESOLVED} resolved registrations before it is reliable.`;
    } else if (wr > overallCohortRate * 2 && wr >= 0.2) {
      const mult = overallCohortRate > 0 ? Math.round(wr / overallCohortRate) : 0;
      insightText = `AEs are closing ${(wr * 100).toFixed(0)}% of qualified deals — ${mult}x the overall ${(overallCohortRate * 100).toFixed(0)}% rate. The gap is explained by leads that never reached SQL.`;
    } else if (wr < 0.15) {
      insightText = `Win rate on qualified deals is ${(wr * 100).toFixed(0)}% — below the threshold where closing performance becomes a concern. Both lead quality and AE execution need attention.`;
    } else {
      insightText = `Win rate on qualified deals is ${(wr * 100).toFixed(0)}% — compared to ${(overallCohortRate * 100).toFixed(0)}% overall. The gap is explained by leads that never reached SQL.`;
    }

    // By-CAM breakdown
    type CamQualityRow = {
      cam: string; drs: number; sqlRate: number; winRateOnSQL: number | null; qualityGap: number;
      sqlResolved: number;
      verdict: 'Lead Quality' | 'Execution' | 'Developing' | 'Performing';
    };
    const byCam = new Map<string, DealRegistration[]>();
    for (const d of scopeNoStatus) {
      const k = d.channelAccountManager || '(none)';
      const arr = byCam.get(k) || [];
      arr.push(d);
      byCam.set(k, arr);
    }
    const camRowsDQ: CamQualityRow[] = [];
    for (const [cam, deals] of byCam.entries()) {
      const nr = deals.filter(d => d.status !== 'rejected');
      const camTotal = nr.length;
      if (camTotal < 5) continue;
      const camSql = nr.filter(everReachedSql).length;
      const camSqlRate = camTotal > 0 ? camSql / camTotal : 0;
      const camResolved = deals.filter(d => everReachedSql(d) && (d.status === 'closed_won' || d.status === 'closed_lost'));
      const camSqlWon = camResolved.filter(d => d.status === 'closed_won').length;
      const camWinOnSql: number | null = camResolved.length > 0 ? camSqlWon / camResolved.length : null;
      const camWon = deals.filter(d => d.status === 'closed_won').length;
      const camCohortRate = camTotal > 0 ? camWon / camTotal : 0;
      const camQualityGap = camWinOnSql !== null ? camWinOnSql - camCohortRate : 0;
      let verdict: CamQualityRow['verdict'];
      if (camSqlRate < 0.2) verdict = 'Lead Quality';
      else if (camWinOnSql === null || camResolved.length < 10) verdict = 'Developing';
      else if (camWinOnSql < 0.15) verdict = 'Execution';
      else if (camWinOnSql >= 0.2) verdict = 'Performing';
      else verdict = 'Developing';
      camRowsDQ.push({ cam, drs: camTotal, sqlRate: camSqlRate, winRateOnSQL: camWinOnSql, qualityGap: camQualityGap, verdict, sqlResolved: camResolved.length });
    }
    const verdictOrder = { 'Lead Quality': 0, 'Execution': 1, 'Developing': 2, 'Performing': 3 } as const;
    camRowsDQ.sort((a, b) => {
      const d = verdictOrder[a.verdict] - verdictOrder[b.verdict];
      return d !== 0 ? d : b.drs - a.drs;
    });

    return {
      total, reachedSQL, convertedToPipeline, closedWon, sqlClosedWon, sqlResolved,
      winRateOnSQL, overallCohortRate, sqlRate, conversionRate, closeRate,
      mortality, insightText, camRowsDQ, qualityGap,
    };
  }, [scopeNoStatus]);

  // Defensible-only funnel stats (excludes padded, stale, rejected, withdrawn)
  const NON_DEFENSIBLE_STATUSES = new Set<string>(['padded', 'stale', 'rejected', 'withdrawn']);
  const dealQualityDefensible = useMemo(() => {
    const drs = scopeNoStatus.filter(d => !NON_DEFENSIBLE_STATUSES.has(d.status));
    const total = drs.length;
    const reachedSQL = drs.filter(everReachedSql).length;
    const convertedToPipeline = drs.filter(d => d.status === 'converted' || d.status === 'closed_won' || d.status === 'closed_lost').length;
    const closedWon = drs.filter(d => d.status === 'closed_won').length;
    const resolved = drs.filter(d => everReachedSql(d) && (d.status === 'closed_won' || d.status === 'closed_lost'));
    const sqlClosedWon = resolved.filter(d => d.status === 'closed_won').length;
    const sqlResolved = resolved.length;
    const winRateOnSQL = sqlResolved > 0 ? sqlClosedWon / sqlResolved : 0;
    const overallCohortRate = total > 0 ? closedWon / total : 0;
    const sqlRate = total > 0 ? reachedSQL / total : 0;
    const qualityGap = winRateOnSQL - overallCohortRate;
    return { total, reachedSQL, convertedToPipeline, closedWon, sqlClosedWon, sqlResolved, winRateOnSQL, overallCohortRate, sqlRate, qualityGap };
  }, [scopeNoStatus]);

  // Headline defensible pipeline value
  const defensiblePipelineValue = useMemo(() => {
    return filtered
      .filter(d => currentlySql(d) && (d.amount ?? 0) > 0 &&
        d.status !== 'closed_won' && d.status !== 'closed_lost' &&
        d.status !== 'rejected' && d.status !== 'withdrawn')
      .reduce((s, d) => s + (d.amount || 0), 0);
  }, [filtered]);

  // No-reseller hygiene list
  const noResellerRows = useMemo(() => {
    return filtered
      .filter(d => !(d.resolvedReseller && d.resolvedReseller.trim()) &&
        d.status !== 'closed_won' && d.status !== 'closed_lost' &&
        d.status !== 'rejected' && d.status !== 'withdrawn')
      .sort((a, b) => (b.amount || 0) - (a.amount || 0));
  }, [filtered]);

  // Exclusion summary for the "Defensible Only" callout
  const dqExclusion = useMemo(() => {
    const excluded = scopeNoStatus.filter(d => NON_DEFENSIBLE_STATUSES.has(d.status));
    // Buckets — "padded only", "stale only", "both" (padded AND stale). Withdrawn/rejected counted separately.
    let paddedOnly = 0, staleOnly = 0, both = 0, withdrawn = 0, rejected = 0;
    for (const d of excluded) {
      const isPad = d.status === 'padded';
      const isStale = d.status === 'stale';
      if (d.status === 'withdrawn') withdrawn++;
      else if (d.status === 'rejected') rejected++;
      else if (isPad && isStale) both++;
      else if (isPad) paddedOnly++;
      else if (isStale) staleOnly++;
    }
    // Top sources by CAM
    const camCounts = new Map<string, number>();
    for (const d of excluded) {
      const k = (d.channelAccountManager || '').trim();
      if (!k) continue;
      camCounts.set(k, (camCounts.get(k) || 0) + 1);
    }
    const topSources = [...camCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([cam, count]) => ({ cam, count }));
    return { total: excluded.length, paddedOnly, staleOnly, both, withdrawn, rejected, topSources };
  }, [scopeNoStatus]);

  // ---------- Render helpers ----------
  const lastBatch = drBatches[drBatches.length - 1];
  const hasData = dealRegistrations.length > 0;
  const activeCount = dealRegistrations.filter(d => d.status === 'active' || d.status === 'sql').length;

  const sortHeader = (key: string, label: string, align: 'left' | 'right' = 'left') => (
    <th
      className={`px-2 py-1.5 font-medium cursor-pointer hover:text-foreground select-none ${align === 'right' ? 'text-right' : 'text-left'}`}
      onClick={() => { if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(key); setSortDir('desc'); } }}
    >
      {label} {sortKey === key ? (sortDir === 'asc' ? '↑' : '↓') : ''}
    </th>
  );

  const colorRate = (r: number, good = 0.4, ok = 0.2) =>
    r >= good ? 'text-green-600 dark:text-green-400' : r >= ok ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400';
  const colorConvRate = (r: number) =>
    r >= 0.2 ? 'text-green-600 dark:text-green-400' : r >= 0.1 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400';
  const colorAge = (a: number) => a > 90 ? 'text-red-600 dark:text-red-400' : a > 45 ? 'text-amber-600 dark:text-amber-400' : '';
  const colorDollar = (n: number) =>
    n > 100_000 ? 'text-green-600 dark:text-green-400' : n >= 10_000 ? 'text-amber-600 dark:text-amber-400' : '';

  return (
    <div className="space-y-6">
      {/* Section A: Upload / status */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          {(!hasData || showUploader) ? (
            <div className="space-y-2">
              {pending ? (
                <div className="border border-border rounded-lg p-4 bg-secondary/40">
                  <div className="flex items-center gap-3 mb-3">
                    <FileSpreadsheet size={20} className="text-muted-foreground" />
                    <div className="flex-1">
                      <p className="text-sm font-medium">{pending.fileName}</p>
                      <p className="text-xs text-muted-foreground">
                        {pending.records.length} records · As of {pending.asOfDate}
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-2 mb-3 text-xs">
                    <div className="px-2 py-1.5 bg-background border border-border rounded">
                      <span className="text-muted-foreground">New: </span><span className="font-semibold">{pending.preview.newCount}</span>
                    </div>
                    <div className="px-2 py-1.5 bg-background border border-border rounded">
                      <span className="text-muted-foreground">Updated: </span><span className="font-semibold">{pending.preview.updatedCount}</span>
                    </div>
                    <div className="px-2 py-1.5 bg-background border border-border rounded">
                      <span className="text-muted-foreground">Converted: </span><span className="font-semibold text-teal-600 dark:text-teal-400">{pending.preview.convertedCount}</span>
                    </div>
                    <div className="px-2 py-1.5 bg-background border border-border rounded">
                      <span className="text-muted-foreground">Rejected: </span><span className="font-semibold text-muted-foreground">{pending.preview.rejectedCount}</span>
                    </div>
                  </div>
                  {pending.errors.length > 0 && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mb-2">{pending.errors.length} parse warning(s)</p>
                  )}
                  <div className="flex gap-2">
                    <Button size="sm" onClick={confirmImport}>Confirm merge</Button>
                    <Button size="sm" variant="outline" onClick={() => setPending(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <UploadZone onParsed={handleParsed} />
              )}
              {hasData && (
                <button onClick={() => { setShowUploader(false); setPending(null); }} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3 p-3 border border-border rounded-md bg-secondary/30">
              <span className="text-base">📊</span>
              <span className="text-xs font-medium">{dealRegistrations.length} DRs</span>
              <span className="text-xs text-muted-foreground">· {activeCount} active</span>
              <span className="text-xs text-muted-foreground">· As of {lastBatch?.asOfDate || '—'}</span>
              <span className="text-xs text-muted-foreground">· Last upload: {lastBatch ? new Date(lastBatch.importedAt).toLocaleString() : '—'}</span>
              <button onClick={() => setShowUploader(true)} className="text-xs text-foreground hover:underline flex items-center gap-1 ml-auto">
                <RefreshCw size={12} /> Upload new batch
              </button>
              <button onClick={() => { if (confirm('Clear all DR data?')) clearDrData(); }} className="text-xs text-muted-foreground hover:text-red-600">Clear</button>
            </div>
          )}
        </div>
        {hasData && (
          <Button variant="outline" size="sm" onClick={exportReport} className="text-xs gap-1.5">
            <Download size={12} /> Export DR Report
          </Button>
        )}
      </div>

      {!hasData && <p className="text-xs text-muted-foreground text-center">No DR data yet. Upload your Salesforce DR report to begin.</p>}

      {hasData && (
        <>
          {/* Data boundary notice */}
          <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>DR data reflects registrations from July 15, 2025 onwards. Closed won matches reflect formally registered deals only — unregistered channel-sourced deals are not included.</span>
          </div>

          {/* Headline: Defensible Pipeline Value */}
          <div className="border border-border rounded-md p-4 bg-secondary/30 flex items-baseline gap-4 flex-wrap">
            <div>
              <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Defensible Pipeline Value</p>
              <p className="text-3xl font-semibold tabular-nums">{fmtDollar(defensiblePipelineValue)}</p>
            </div>
            <p className="text-[11px] text-muted-foreground max-w-md">
              Sum of amount where probability ≥ 25% and the registration is still open. Pre-discovery dollars are excluded.
            </p>
          </div>

          {/* Global filter bar */}
          <div className="p-3 border border-border rounded-md bg-secondary/20 space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-xs"><span className="text-muted-foreground mr-1">Rep:</span>
                <select value={repFilter} onChange={e => setRepFilter(e.target.value)} className="text-xs bg-background border border-border rounded px-1.5 py-1">
                  <option value="all">All</option>{allReps.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              <label className="text-xs"><span className="text-muted-foreground mr-1">CAM:</span>
                <select value={camFilter} onChange={e => setCamFilter(e.target.value)} className="text-xs bg-background border border-border rounded px-1.5 py-1">
                  <option value="all">All</option>{allCams.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="text-xs"><span className="text-muted-foreground mr-1">Period:</span>
                <select value={period} onChange={e => setPeriod(e.target.value as Period)} className="text-xs bg-background border border-border rounded px-1.5 py-1">
                  <option value="this-month">This month</option>
                  <option value="last-month">Last month</option>
                  <option value="this-quarter">This quarter</option>
                  <option value="last-quarter">Last quarter</option>
                  <option value="all">All time</option>
                </select>
              </label>
              {filtersActive && <button onClick={clearFilters} className="text-xs text-foreground hover:underline">Clear filters</button>}
              <span className="text-xs text-muted-foreground ml-auto">{filtered.length} DRs in scope</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground mr-1">Status:</span>
              {STATUS_CHIPS.map(c => {
                const on = statuses.has(c.key);
                return (
                  <button key={c.key}
                    onClick={() => {
                      setStatuses(prev => {
                        const next = new Set(prev);
                        if (next.has(c.key)) next.delete(c.key); else next.add(c.key);
                        return next;
                      });
                    }}
                    className={`px-2 py-0.5 rounded text-[11px] border transition-colors ${on ? statusBadgeCls(c.key) + ' border-transparent' : 'border-border text-muted-foreground hover:text-foreground'}`}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Deal Quality Analysis */}
          {(() => {
            const dqAll = dealQuality;
            const dqDef = dealQualityDefensible;
            const dq = dqView === 'defensible' ? dqDef : dqAll;
            const cohortColor = dq.overallCohortRate >= 0.2 ? 'text-green-600 dark:text-green-400' : dq.overallCohortRate >= 0.1 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400';
            const winColor = dq.winRateOnSQL >= 0.25 ? 'text-green-600 dark:text-green-400' : dq.winRateOnSQL >= 0.15 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400';
            const dropColor = (d: number) => d > 0.6 ? 'text-red-600 dark:text-red-400' : d >= 0.4 ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400';
            const verdictBadge = (v: string) => {
              switch (v) {
                case 'Lead Quality': return 'bg-red-500/15 text-red-700 dark:text-red-400';
                case 'Execution': return 'bg-amber-500/15 text-amber-700 dark:text-amber-400';
                case 'Performing': return 'bg-green-500/15 text-green-700 dark:text-green-400';
                case 'Developing': return 'bg-blue-500/15 text-blue-700 dark:text-blue-400';
                default: return 'bg-muted text-muted-foreground';
              }
            };
            const t = dq.total || 1;
            const funnelLabel = dqView === 'defensible' ? 'Defensible DRs' : 'DRs Registered';
            const funnelStages = [
              { label: funnelLabel, count: dq.total, pct: 1, color: 'bg-muted-foreground/40' },
              { label: 'Reached SQL (25%+)', count: dq.reachedSQL, pct: dq.reachedSQL / t, color: 'bg-blue-500/70' },
              { label: 'In Pipeline', count: dq.convertedToPipeline, pct: dq.convertedToPipeline / t, color: 'bg-amber-500/70' },
              { label: 'Closed Won', count: dq.closedWon, pct: dq.closedWon / t, color: 'bg-green-500/70' },
            ];
            const dropoffs = [
              dq.total > 0 ? (dq.total - dq.reachedSQL) / dq.total : 0,
              dq.reachedSQL > 0 ? (dq.reachedSQL - dq.convertedToPipeline) / dq.reachedSQL : 0,
              dq.convertedToPipeline > 0 ? (dq.convertedToPipeline - dq.closedWon) / dq.convertedToPipeline : 0,
            ];
            const dropLabels = [
              'did not qualify',
              'did not convert',
              'did not close',
            ];
            // Dual-view insight statement
            const overallAllPct = (dqAll.overallCohortRate * 100).toFixed(0);
            const overallDefPct = (dqDef.overallCohortRate * 100).toFixed(0);
            const winDefPct = (dqDef.winRateOnSQL * 100).toFixed(0);
            const dualInsight = `Overall cohort rate is ${overallAllPct}% across all DRs. On defensible pipeline only — excluding padded and stale registrations — the rate is ${overallDefPct}% with a ${winDefPct}% win rate on SQL'd deals. Partners are diluting results with unqualified volume.`;
            return (
              <section className="border border-border rounded-md">
                <button
                  onClick={() => setQualityExpanded(v => !v)}
                  className="w-full px-3 py-2 border-b border-border flex items-center justify-between gap-3 hover:bg-secondary/30 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    {qualityExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <div className="text-left">
                      <h3 className="text-xs font-semibold">Deal Quality Analysis</h3>
                      <p className="text-[11px] text-muted-foreground">Where deals die — and why it matters.</p>
                    </div>
                  </div>
                  <span className="text-[11px] text-muted-foreground">{dq.total} DRs in scope</span>
                </button>

                {qualityExpanded && (
                  <div className="p-4 space-y-5">
                    {dqAll.total < 10 ? (
                      <p className="text-xs text-muted-foreground text-center py-6">Not enough data yet — minimum 10 DRs required for this analysis.</p>
                    ) : (
                      <>
                        {/* View toggle */}
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Show:</span>
                          <div className="inline-flex border border-border rounded-md overflow-hidden text-xs">
                            <button
                              type="button"
                              onClick={() => setDqView('all')}
                              className={`px-3 py-1.5 ${dqView === 'all' ? 'bg-secondary text-foreground' : 'bg-transparent text-muted-foreground hover:bg-secondary/40'}`}
                            >
                              All DRs ({dqAll.total})
                            </button>
                            <button
                              type="button"
                              onClick={() => setDqView('defensible')}
                              className={`px-3 py-1.5 border-l border-border ${dqView === 'defensible' ? 'bg-secondary text-foreground' : 'bg-transparent text-muted-foreground hover:bg-secondary/40'}`}
                            >
                              Defensible Only ({dqDef.total})
                            </button>
                          </div>
                          {dqView === 'defensible' && (
                            <span className="text-[11px] text-muted-foreground">Excludes padded, stale, rejected, withdrawn</span>
                          )}
                        </div>

                        {/* Exclusion callout when defensible */}
                        {dqView === 'defensible' && dqExclusion.total > 0 && (
                          <div className="border border-amber-500/30 bg-amber-500/5 rounded-md px-3 py-2 text-xs">
                            <p>
                              <span className="font-medium">Excluding {dqExclusion.total} non-defensible DRs:</span>{' '}
                              {[
                                dqExclusion.paddedOnly > 0 ? `${dqExclusion.paddedOnly} padded accounts` : null,
                                dqExclusion.staleOnly > 0 ? `${dqExclusion.staleOnly} stale` : null,
                                dqExclusion.both > 0 ? `${dqExclusion.both} both` : null,
                                dqExclusion.withdrawn > 0 ? `${dqExclusion.withdrawn} withdrawn` : null,
                                dqExclusion.rejected > 0 ? `${dqExclusion.rejected} rejected` : null,
                              ].filter(Boolean).join(', ')}.
                            </p>
                            {dqExclusion.topSources.length > 0 && (
                              <p className="mt-0.5 text-muted-foreground">
                                Primary sources: {dqExclusion.topSources.map(s => `${s.cam} (${s.count})`).join(', ')}.
                              </p>
                            )}
                          </div>
                        )}

                        {/* Funnel */}
                        <div className="space-y-1">
                          {funnelStages.map((s, i) => (
                            <Fragment key={s.label}>
                              <div className="flex items-center gap-3">
                                <div className="w-44 text-xs text-muted-foreground shrink-0">{s.label}</div>
                                <div className="w-12 text-xs font-mono text-right tabular-nums shrink-0">[{s.count}]</div>
                                <div className="flex-1 relative h-6 bg-secondary/40 rounded-sm overflow-hidden">
                                  <div
                                    className={`h-full ${s.color} transition-all`}
                                    style={{ width: `${Math.max(s.pct * 100, 0.5)}%` }}
                                  />
                                </div>
                                <div className="w-12 text-xs font-mono text-right tabular-nums text-muted-foreground shrink-0">
                                  {(s.pct * 100).toFixed(0)}%
                                </div>
                              </div>
                              {i < dropoffs.length && (
                                <div className="flex items-center gap-3 pl-44 ml-3">
                                  <span className="text-[11px] text-red-600/80 dark:text-red-400/80">
                                    ↓ {(dropoffs[i] * 100).toFixed(0)}% {dropLabels[i]}
                                  </span>
                                </div>
                              )}
                            </Fragment>
                          ))}
                        </div>

                        {/* Stat cards */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                          <div className="border border-border rounded-md p-3">
                            <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Overall Cohort Rate</p>
                            {dqView === 'all' ? (
                              <>
                                <p className="text-2xl font-semibold mt-1">
                                  <span className={cohortColor}>{fmtPct(dqAll.overallCohortRate, 0)}</span>
                                  <span className="text-muted-foreground"> (all) / </span>
                                  <span className={dqDef.overallCohortRate >= 0.2 ? 'text-green-600 dark:text-green-400' : dqDef.overallCohortRate >= 0.1 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}>{fmtPct(dqDef.overallCohortRate, 0)}</span>
                                  <span className="text-muted-foreground text-sm"> (defensible)</span>
                                </p>
                                <p className="text-[11px] text-muted-foreground mt-0.5">All DRs vs. defensible only</p>
                              </>
                            ) : (
                              <>
                                <p className={`text-2xl font-semibold mt-1 ${cohortColor}`}>{fmtPct(dq.overallCohortRate, 1)}</p>
                                <p className="text-[11px] text-muted-foreground mt-0.5">Defensible DRs → Closed Won</p>
                              </>
                            )}
                          </div>
                          <div className="border border-border rounded-md p-3">
                            <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Win Rate on SQL'd Deals</p>
                            <p className={`text-2xl font-semibold mt-1 ${winColor}`}>{fmtPct(dq.winRateOnSQL, 1)}</p>
                            <p className="text-[11px] text-muted-foreground mt-0.5">
                              {('sqlResolved' in dq) ? `${(dq as any).sqlClosedWon}/${(dq as any).sqlResolved} resolved (won + lost)` : 'Resolved SQL deals → Closed Won'}
                            </p>
                            <p className="text-[10px] text-muted-foreground mt-0.5 italic">Based on registrations observed reaching SQL across imports — floor, not absolute.</p>
                          </div>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="border border-border rounded-md p-3 cursor-help">
                                <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Lead Quality Gap</p>
                                {dqView === 'all' ? (
                                  <p className="text-2xl font-semibold mt-1">
                                    <span className="text-amber-600 dark:text-amber-400">+{(dqAll.qualityGap * 100).toFixed(0)} pts</span>
                                    <span className="text-muted-foreground"> (all) / </span>
                                    <span className="text-amber-600 dark:text-amber-400">+{(dqDef.qualityGap * 100).toFixed(0)} pts</span>
                                    <span className="text-muted-foreground text-sm"> (defensible)</span>
                                  </p>
                                ) : (
                                  <p className="text-2xl font-semibold mt-1 text-amber-600 dark:text-amber-400">+{(dq.qualityGap * 100).toFixed(1)} pts</p>
                                )}
                                <p className="text-[11px] text-muted-foreground mt-0.5">Win rate on qualified deals vs. overall</p>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-xs">
                              <p>AEs close at {(dq.winRateOnSQL * 100).toFixed(0)}% when given a qualified lead.</p>
                              <p>The overall {(dq.overallCohortRate * 100).toFixed(0)}% reflects leads that never qualified.</p>
                            </TooltipContent>
                          </Tooltip>
                        </div>

                        {/* Insight line */}
                        <div className="border-l-2 border-foreground/40 pl-3 py-1">
                          <p className="text-sm font-medium">{dualInsight}</p>
                        </div>


                        {/* Stage mortality table */}
                        <div>
                          <h4 className="text-xs font-semibold mb-2">Stage Mortality</h4>
                          <div className="overflow-x-auto border border-border rounded-md">
                            <table className="w-full text-xs">
                              <thead className="bg-secondary/40 text-muted-foreground">
                                <tr>
                                  <th className="px-2 py-1.5 text-left font-medium">From Stage</th>
                                  <th className="px-2 py-1.5 text-left font-medium">To Stage</th>
                                  <th className="px-2 py-1.5 text-right font-medium">Deals</th>
                                  <th className="px-2 py-1.5 text-right font-medium">Drop-off</th>
                                  <th className="px-2 py-1.5 text-right font-medium">Avg Days at Stage</th>
                                </tr>
                              </thead>
                              <tbody>
                                {dqAll.mortality.map((m, i) => (
                                  <tr key={i} className="border-t border-border">
                                    <td className="px-2 py-1.5">{m.from}</td>
                                    <td className="px-2 py-1.5">
                                      {m.to}
                                      {m.isGate && <span className="ml-2 text-[10px] text-muted-foreground">← Partner quality gate</span>}
                                    </td>
                                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{m.fromCount} → {m.toCount}</td>
                                    <td className={`px-2 py-1.5 text-right font-mono tabular-nums ${m.isTerminal ? 'text-muted-foreground' : dropColor(m.dropOff)}`}>
                                      {m.isTerminal ? '—' : `${(m.dropOff * 100).toFixed(0)}%`}
                                    </td>
                                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{m.avgDays.toFixed(0)}d</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>

                        {/* By-CAM quality breakdown */}
                        <div>
                          <h4 className="text-xs font-semibold mb-2">By-CAM Quality Breakdown <span className="text-[11px] font-normal text-muted-foreground">(min 5 DRs)</span></h4>
                          {dqAll.camRowsDQ.length === 0 ? (
                            <p className="text-xs text-muted-foreground">No CAMs meet the 5-DR minimum in this scope.</p>
                          ) : (
                            <div className="overflow-x-auto border border-border rounded-md">
                              <table className="w-full text-xs">
                                <thead className="bg-secondary/40 text-muted-foreground">
                                  <tr>
                                    <th className="px-2 py-1.5 text-left font-medium">CAM</th>
                                    <th className="px-2 py-1.5 text-right font-medium">DRs</th>
                                    <th className="px-2 py-1.5 text-right font-medium">SQL Rate</th>
                                    <th className="px-2 py-1.5 text-right font-medium">Win Rate (on SQL)</th>
                                    <th className="px-2 py-1.5 text-right font-medium">Quality Gap</th>
                                    <th className="px-2 py-1.5 text-center font-medium">Verdict</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {dqAll.camRowsDQ.map((r) => (
                                    <tr key={r.cam} className="border-t border-border">
                                      <td className="px-2 py-1.5">{r.cam}</td>
                                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{r.drs}</td>
                                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtPct(r.sqlRate, 0)}</td>
                                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtPct(r.winRateOnSQL, 0)}</td>
                                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{(r.qualityGap * 100).toFixed(0)}pp</td>
                                      <td className="px-2 py-1.5 text-center">
                                        <span className={`px-2 py-0.5 rounded text-[11px] ${verdictBadge(r.verdict)}`}>{r.verdict}</span>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </section>
            );
          })()}


          {/* Section B: AE Accountability */}
          <section className="border border-border rounded-md">
            <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-3 flex-wrap">
              <h3 className="text-xs font-semibold">AE Accountability</h3>
              <div className="flex items-center gap-3 flex-wrap">
                <label className="text-[11px] text-muted-foreground flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showInactiveReps}
                    onChange={(e) => setShowInactiveReps(e.target.checked)}
                    className="h-3 w-3 rounded border-border"
                  />
                  Show inactive reps
                  {hiddenInactiveCount > 0 && !showInactiveReps && (
                    <span className="text-muted-foreground">({hiddenInactiveCount} hidden)</span>
                  )}
                </label>
                {expandedRep && (
                  <button onClick={() => setExpandedRep(null)} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                    <X size={12} /> Clear rep filter ({expandedRep})
                  </button>
                )}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-secondary/40 text-muted-foreground">
                  <tr>
                    <th className="text-left px-2 py-1.5 font-medium">Rep</th>
                    <th className="text-right px-2 py-1.5 font-medium" title="Total DRs including rejected">Assigned</th>
                    <th className="text-right px-2 py-1.5 font-medium" title="DRs this rep explicitly rejected in Salesforce">Rejected</th>
                    <th className="text-right px-2 py-1.5 font-medium">SQL Rate</th>
                    <th className="text-right px-2 py-1.5 font-medium" title="Sum of amount on SQL'd, open DRs with amount > 0">Pipeline $</th>
                    <th className="text-right px-2 py-1.5 font-medium">Converted</th>
                    <th className="text-right px-2 py-1.5 font-medium">Closed Won</th>
                    <th className="text-right px-2 py-1.5 font-medium" title="Lifetime closed won revenue">Closed Won $</th>
                    <th className="text-right px-2 py-1.5 font-semibold" title="Closed Won / Assigned (excl. rejected)">Cohort Rate</th>
                    <th className="text-right px-2 py-1.5 font-medium">Avg Cycle</th>
                    <th className="text-right px-2 py-1.5 font-medium">Stale</th>
                    <th className="text-right px-2 py-1.5 font-medium">No Activity</th>
                    <th className="text-right px-2 py-1.5 font-medium" title="Non-terminal, not currently SQL, no activity, created > 15d ago — partner has not been engaged">Unworked</th>
                  </tr>
                </thead>
                <tbody>
                  {aeRows.map(r => (
                    <Fragment key={r.rep}>
                      <tr
                        onClick={() => setExpandedRep(expandedRep === r.rep ? null : r.rep)}
                        className={`border-t border-border cursor-pointer hover:bg-muted/40 ${expandedRep === r.rep ? 'bg-muted/60' : ''}`}>
                        <td className="px-2 py-1.5 font-medium">{r.rep}</td>
                        <td className="text-right px-2 py-1.5">{r.assigned}</td>
                        <td className={`text-right px-2 py-1.5 ${r.rejected > 15 ? 'text-red-600 dark:text-red-400 font-medium' : r.rejected > 5 ? 'text-amber-600 dark:text-amber-400' : ''}`}>{r.rejected}</td>
                        <td className={`text-right px-2 py-1.5 font-medium ${colorRate(r.sqlRate)}`}>{fmtPct(r.sqlRate, 1)}</td>
                        <td className="text-right px-2 py-1.5">{fmtDollar(r.pipelineAmount)}</td>
                        <td className="text-right px-2 py-1.5">{r.converted}</td>
                        <td className="text-right px-2 py-1.5 font-semibold text-emerald-700 dark:text-emerald-400">{r.closedWon}</td>
                        <td className="text-right px-2 py-1.5">{fmtDollar(r.closedWonAmount)}</td>
                        <td className={`text-right px-2 py-1.5 font-semibold ${colorConvRate(r.cohortRate)}`}>{fmtPct(r.cohortRate, 1)}</td>
                        <td className={`text-right px-2 py-1.5 ${r.avgCycle !== null ? (r.avgCycle < 90 ? 'text-green-600 dark:text-green-400' : r.avgCycle <= 180 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400') : ''}`}>
                          {r.avgCycle !== null ? `${r.avgCycle.toFixed(0)} days` : '—'}
                        </td>
                        <td className={`text-right px-2 py-1.5 ${r.stale > 0 ? 'text-red-600 dark:text-red-400 font-medium' : ''}`}>{r.stale}</td>
                        <td className={`text-right px-2 py-1.5 ${r.noActivity > 3 ? 'text-amber-600 dark:text-amber-400 font-medium' : ''}`}>{r.noActivity}</td>
                        <td className={`text-right px-2 py-1.5 ${r.unworkedPct >= 0.3 ? 'text-red-600 dark:text-red-400 font-medium' : r.unworkedPct >= 0.15 ? 'text-amber-600 dark:text-amber-400' : ''}`} title="Unworked / non-terminal book">
                          {r.unworked} <span className="text-[10px] text-muted-foreground">({fmtPct(r.unworkedPct, 0)})</span>
                        </td>
                      </tr>
                      {expandedRep === r.rep && (
                        <tr className="bg-muted/20 border-t border-border">
                          <td colSpan={13} className="px-3 py-2 space-y-3">
                            {r.rejected > 0 && (
                              <div>
                                <p className="text-[11px] font-semibold text-muted-foreground mb-1">Rejected DRs by CAM (coaching context)</p>
                                <table className="text-[11px]">
                                  <thead className="text-muted-foreground">
                                    <tr><th className="text-left pr-4 py-0.5 font-medium">CAM</th><th className="text-right pr-4 py-0.5 font-medium">Rejected DRs</th><th className="text-left py-0.5 font-medium">Products</th></tr>
                                  </thead>
                                  <tbody>
                                    {Array.from(r.rejectedByCam.entries()).sort((a,b) => b[1].count - a[1].count).map(([cam, info]) => (
                                      <tr key={cam}><td className="pr-4 py-0.5">{cam}</td><td className="text-right pr-4 py-0.5">{info.count}</td><td className="py-0.5 text-muted-foreground">{info.products.join(', ') || '—'}</td></tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                            <div>
                              <p className="text-[11px] font-semibold text-muted-foreground mb-1">Cohort breakdown by quarter created</p>
                              {r.cohort.length === 0 ? (
                                <p className="text-[11px] text-muted-foreground">No data.</p>
                              ) : (
                                <table className="text-[11px]">
                                  <thead className="text-muted-foreground">
                                    <tr>
                                      <th className="text-left pr-4 py-0.5 font-medium">Quarter Created</th>
                                      <th className="text-right pr-4 py-0.5 font-medium">Assigned</th>
                                      <th className="text-right pr-4 py-0.5 font-medium">SQL'd</th>
                                      <th className="text-right pr-4 py-0.5 font-medium">Closed Won</th>
                                      <th className="text-right pr-4 py-0.5 font-medium">Cohort Rate</th>
                                      <th className="text-right py-0.5 font-medium">Avg Cycle</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {r.cohort.map(c => (
                                      <tr key={c.quarter}>
                                        <td className="pr-4 py-0.5">{c.quarter}</td>
                                        <td className="text-right pr-4 py-0.5">{c.total}</td>
                                        <td className="text-right pr-4 py-0.5">{c.sql}</td>
                                        <td className="text-right pr-4 py-0.5">{c.closedWon}</td>
                                        <td className={`text-right pr-4 py-0.5 ${colorConvRate(c.cohortRate)}`}>{fmtPct(c.cohortRate, 0)}</td>
                                        <td className="text-right py-0.5">{c.avgCycle !== null ? `${c.avgCycle.toFixed(0)} days` : '—'}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                              <p className="text-[10px] text-muted-foreground mt-1">Recent quarters will show lower rates as deals are still in progress.</p>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                  <tr className="border-t-2 border-border font-medium bg-secondary/30">
                    <td className="px-2 py-1.5">Team</td>
                    <td className="text-right px-2 py-1.5">{aeTotals.assigned}</td>
                    <td className="text-right px-2 py-1.5">{aeTotals.rejected}</td>
                    <td className={`text-right px-2 py-1.5 ${colorRate(aeTotals.sqlRate)}`}>{fmtPct(aeTotals.sqlRate, 1)}</td>
                    <td className="text-right px-2 py-1.5">{fmtDollar(aeTotals.pipelineAmount)}</td>
                    <td className="text-right px-2 py-1.5">{aeTotals.converted}</td>
                    <td className="text-right px-2 py-1.5">{aeTotals.closedWon}</td>
                    <td className="text-right px-2 py-1.5">{fmtDollar(aeTotals.closedWonAmount)}</td>
                    <td className={`text-right px-2 py-1.5 font-semibold ${colorConvRate(aeTotals.convRate)}`}>{fmtPct(aeTotals.convRate, 1)}</td>
                    <td className="text-right px-2 py-1.5">—</td>
                    <td className="text-right px-2 py-1.5">{aeTotals.stale}</td>
                    <td className="text-right px-2 py-1.5">{aeTotals.noActivity}</td>
                    <td className="text-right px-2 py-1.5">{aeRows.reduce((s, r) => s + r.unworked, 0)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {aeInsights.length > 0 && (
              <div className="px-3 py-2 border-t border-border bg-secondary/20 space-y-1">
                {aeInsights.map((line, i) => <p key={i} className="text-xs">{line}</p>)}
              </div>
            )}
          </section>

          {/* Section C: CAM Cohort & Cycle (collapsible) */}
          <section className="border border-border rounded-md">
            <button onClick={() => setShowCam(s => !s)} className="w-full px-3 py-2 flex items-center justify-between hover:bg-muted/30">
              <h3 className="text-xs font-semibold flex items-center gap-1.5">
                {showCam ? <ChevronDown size={12} /> : <ChevronRight size={12} />} CAM Cohort & Cycle
              </h3>
              <span className="text-xs text-muted-foreground">{camRows.length} CAMs · excludes Rejected</span>
            </button>
            {showCam && (
              <>
                <div className="overflow-x-auto border-t border-border">
                  <table className="w-full text-xs">
                    <thead className="bg-secondary/40 text-muted-foreground">
                      <tr>
                        {([
                          ['cam','CAM','left'],
                          ['totalDrs','Total DRs','right'],
                          ['sqlRate','SQL Rate','right'],
                          ['pipelineAmount','Pipeline $','right'],
                          ['closedWonAmount','Closed Won $','right'],
                          ['closedWon','Closed Won','right'],
                          ['cohortRate','Cohort Rate','right'],
                          ['avgCycle','Avg Cycle','right'],
                          ['fastest','Fastest','right'],
                          ['slowest','Slowest','right'],
                          ['inPeriodWon','In-Period Won','right'],
                          ['withdrawnRate','Withdrawn %','right'],
                        ] as [keyof CamRow, string, 'left'|'right'][]).map(([k, label, align]) => {
                          const tooltip =
                            k === 'cohortRate' ? '% of all DRs this CAM registered that closed won, regardless of timeframe' :
                            k === 'inPeriodWon' ? 'DRs created and closed won within the same quarter' :
                            k === 'withdrawnRate' ? 'DRs that disappeared from the report without converting or being explicitly rejected — possible CAM disengagement' :
                            undefined;
                          return (
                            <th key={k} title={tooltip}
                              className={`px-2 py-1.5 font-medium cursor-pointer select-none hover:text-foreground ${align === 'right' ? 'text-right' : 'text-left'} ${k === 'cohortRate' ? 'font-semibold' : ''}`}
                              onClick={() => {
                                if (camSortKey === k) setCamSortDir(d => d === 'asc' ? 'desc' : 'asc');
                                else { setCamSortKey(k); setCamSortDir('desc'); }
                              }}>
                              {label}{camSortKey === k ? (camSortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {camRows.map(r => {
                        const isOpen = expandedCam === r.cam;
                        return (
                          <Fragment key={r.cam}>
                            <tr
                              onClick={() => setExpandedCam(isOpen ? null : r.cam)}
                              className={`border-t border-border cursor-pointer hover:bg-muted/40 ${isOpen ? 'bg-muted/60' : ''}`}>
                              <td className="px-2 py-1.5 font-medium">{r.cam}</td>
                              <td className="text-right px-2 py-1.5">{r.totalDrs}</td>
                              <td className={`text-right px-2 py-1.5 font-medium ${colorRate(r.sqlRate)}`}>{fmtPct(r.sqlRate, 1)}</td>
                              <td className="text-right px-2 py-1.5">{fmtDollar(r.pipelineAmount)}</td>
                              <td className={`text-right px-2 py-1.5 ${colorDollar(r.closedWonAmount)}`}>{fmtDollar(r.closedWonAmount)}</td>
                              <td className="text-right px-2 py-1.5">{r.closedWon}</td>
                              <td className={`text-right px-2 py-1.5 font-semibold ${colorConvRate(r.cohortRate)}`}>{fmtPct(r.cohortRate, 1)}</td>
                              <td className={`text-right px-2 py-1.5 ${r.avgCycle !== null ? (r.avgCycle < 90 ? 'text-green-600 dark:text-green-400' : r.avgCycle <= 180 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400') : ''}`}>
                                {r.avgCycle !== null ? `${r.avgCycle.toFixed(0)} days` : '—'}
                              </td>
                              <td className="text-right px-2 py-1.5">{r.fastest !== null ? `${r.fastest} days` : '—'}</td>
                              <td className="text-right px-2 py-1.5">{r.slowest !== null ? `${r.slowest} days` : '—'}</td>
                              <td className="text-right px-2 py-1.5">{r.inPeriodWon}</td>
                              <td className={`text-right px-2 py-1.5 ${r.withdrawnRate > 0.4 ? 'text-red-600 dark:text-red-400 font-medium' : r.withdrawnRate > 0.2 ? 'text-amber-600 dark:text-amber-400' : ''}`}>{fmtPct(r.withdrawnRate, 0)}</td>
                            </tr>
                            {isOpen && (
                              <tr className="bg-muted/20 border-t border-border">
                                <td colSpan={12} className="px-3 py-2 space-y-2">
                                  <p className="text-[11px]">
                                    <span className="text-muted-foreground">Pipeline $: </span><span className="font-semibold">{fmtDollar(r.pipelineAmount)}</span>
                                    <span className="text-muted-foreground"> · Closed Won $: </span><span className="font-semibold">{fmtDollar(r.closedWonAmount)}</span>
                                    <span className="text-muted-foreground"> · Avg Deal Size (CW): </span><span className="font-semibold">{fmtDollar(r.closedWon > 0 ? r.closedWonAmount / r.closedWon : 0)}</span>
                                  </p>
                                  <p className="text-[11px] font-semibold text-muted-foreground mb-1">Vintage breakdown by created quarter</p>
                                  {r.cohort.length === 0 ? (
                                    <p className="text-[11px] text-muted-foreground">No data.</p>
                                  ) : (
                                    <table className="text-[11px]">
                                      <thead className="text-muted-foreground">
                                        <tr>
                                          <th className="text-left pr-4 py-0.5 font-medium">Quarter Created</th>
                                          <th className="text-right pr-4 py-0.5 font-medium">DRs</th>
                                          <th className="text-right pr-4 py-0.5 font-medium">SQL'd</th>
                                          <th className="text-right pr-4 py-0.5 font-medium">Closed Won</th>
                                          <th className="text-right pr-4 py-0.5 font-medium">Cohort Rate</th>
                                          <th className="text-right py-0.5 font-medium">Avg Cycle</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {r.cohort.map(c => (
                                          <tr key={c.quarter}>
                                            <td className="pr-4 py-0.5">{c.quarter}</td>
                                            <td className="text-right pr-4 py-0.5">{c.total}</td>
                                            <td className="text-right pr-4 py-0.5">{c.sql}</td>
                                            <td className="text-right pr-4 py-0.5">{c.closedWon}</td>
                                            <td className={`text-right pr-4 py-0.5 ${colorConvRate(c.cohortRate)}`}>{fmtPct(c.cohortRate, 0)}</td>
                                            <td className="text-right py-0.5">{c.avgCycle !== null ? `${c.avgCycle.toFixed(0)} days` : '—'}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}
                                  <p className="text-[10px] text-muted-foreground mt-1">Recent quarters will show lower rates as deals are still in progress.</p>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                      <tr className="border-t-2 border-border font-medium bg-secondary/30">
                        <td className="px-2 py-1.5">Total</td>
                        <td className="text-right px-2 py-1.5">{camTotals.totalDrs}</td>
                        <td className={`text-right px-2 py-1.5 ${colorRate(camTotals.sqlRate)}`}>{fmtPct(camTotals.sqlRate, 1)}</td>
                        <td className="text-right px-2 py-1.5">{fmtDollar(camTotals.pipelineAmount)}</td>
                        <td className="text-right px-2 py-1.5">{fmtDollar(camTotals.closedWonAmount)}</td>
                        <td className="text-right px-2 py-1.5">{camTotals.closedWon}</td>
                        <td className={`text-right px-2 py-1.5 ${colorConvRate(camTotals.cohortRate)}`}>{fmtPct(camTotals.cohortRate, 1)}</td>
                        <td className="text-right px-2 py-1.5">{camTotals.avgCycle !== null ? `${camTotals.avgCycle.toFixed(0)} days` : '—'}</td>
                        <td className="text-right px-2 py-1.5">—</td>
                        <td className="text-right px-2 py-1.5">—</td>
                        <td className="text-right px-2 py-1.5">{camTotals.inPeriodWon}</td>
                        <td className="text-right px-2 py-1.5">{fmtPct(camTotals.withdrawnRate, 0)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                {camInsights.length > 0 && (
                  <div className="px-3 py-2 border-t border-border bg-secondary/20 space-y-1">
                    {camInsights.map((line, i) => <p key={i} className="text-xs">{line}</p>)}
                  </div>
                )}
              </>
            )}
          </section>

          {/* Section C2: Reseller Performance (collapsible) */}
          <section className="border border-border rounded-md">
            <button onClick={() => setShowReseller(s => !s)} className="w-full px-3 py-2 flex items-center justify-between hover:bg-muted/30">
              <div className="text-left">
                <h3 className="text-xs font-semibold flex items-center gap-1.5">
                  {showReseller ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Reseller Performance
                </h3>
                <p className="text-[10px] text-muted-foreground mt-0.5 ml-4">Conversion and quality metrics by partner. Only resellers with DR data are shown.</p>
              </div>
              <span className="text-xs text-muted-foreground">{resellerRows.length} partners · min 3 DRs</span>
            </button>
            {showReseller && (
              <>
                <div className="overflow-x-auto border-t border-border">
                  <table className="w-full text-xs">
                    <thead className="bg-secondary/40 text-muted-foreground">
                      <tr>
                        {([
                          ['reseller','Reseller','left'],
                          ['totalDrs','Total DRs','right'],
                          ['sqlRate','SQL Rate','right'],
                          ['pipelineAmount','Pipeline $','right'],
                          ['closedWonAmount','Closed Won $','right'],
                          ['cohortRate','Cohort Rate','right'],
                          ['avgCycle','Avg Cycle','right'],
                          ['fastest','Fastest','right'],
                          ['slowest','Slowest','right'],
                          ['activeReps','Active Reps','right'],
                          ['topCam','Top CAM','left'],
                          ['paddedAccts','Padded Accts','right'],
                          ['paddingRate','Padding %','right'],
                        ] as [keyof ResellerRow, string, 'left'|'right'][]).map(([k, label, align]) => {
                          const tooltip = k === 'cohortRate' ? "% of this reseller's DRs that closed won, all time" : undefined;
                          return (
                            <th key={k} title={tooltip}
                              className={`px-2 py-1.5 font-medium cursor-pointer select-none hover:text-foreground ${align === 'right' ? 'text-right' : 'text-left'} ${k === 'cohortRate' ? 'font-semibold' : ''}`}
                              onClick={() => {
                                if (resellerSortKey === k) setResellerSortDir(d => d === 'asc' ? 'desc' : 'asc');
                                else { setResellerSortKey(k); setResellerSortDir('desc'); }
                              }}>
                              {label}{resellerSortKey === k ? (resellerSortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {resellerRows.length === 0 && (
                        <tr><td colSpan={13} className="px-3 py-4 text-center text-muted-foreground">No resellers with 3+ DRs in scope.</td></tr>
                      )}
                      {resellerRows.map(r => {
                        const isOpen = expandedReseller === r.reseller;
                        return (
                          <Fragment key={r.reseller}>
                            <tr
                              onClick={() => setExpandedReseller(isOpen ? null : r.reseller)}
                              className={`border-t border-border cursor-pointer hover:bg-muted/40 ${isOpen ? 'bg-muted/60' : ''}`}>
                              <td className="px-2 py-1.5 font-medium">{r.reseller}</td>
                              <td className="text-right px-2 py-1.5">{r.totalDrs}</td>
                              <td className={`text-right px-2 py-1.5 ${colorRate(r.sqlRate)}`}>{fmtPct(r.sqlRate, 0)}</td>
                              <td className="text-right px-2 py-1.5">{fmtDollar(r.pipelineAmount)}</td>
                              <td className={`text-right px-2 py-1.5 ${colorDollar(r.closedWonAmount)}`}>{fmtDollar(r.closedWonAmount)}</td>
                              <td className={`text-right px-2 py-1.5 font-semibold ${r.cohortRate >= 0.15 ? 'text-green-600 dark:text-green-400' : r.cohortRate >= 0.08 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}>{fmtPct(r.cohortRate, 0)}</td>
                              <td className={`text-right px-2 py-1.5 ${r.avgCycle !== null ? (r.avgCycle < 90 ? 'text-green-600 dark:text-green-400' : r.avgCycle <= 180 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400') : ''}`}>
                                {r.avgCycle !== null ? `${r.avgCycle.toFixed(0)} days` : '—'}
                              </td>
                              <td className="text-right px-2 py-1.5">{r.fastest !== null ? `${r.fastest} days` : '—'}</td>
                              <td className="text-right px-2 py-1.5">{r.slowest !== null ? `${r.slowest} days` : '—'}</td>
                              <td className="text-right px-2 py-1.5">{r.activeReps}</td>
                              <td className="px-2 py-1.5 text-muted-foreground">{r.topCam}</td>
                              <td className="text-right px-2 py-1.5">{r.paddedAccts}</td>
                              <td className={`text-right px-2 py-1.5 font-semibold ${r.paddingRate >= 0.2 ? 'text-red-600 dark:text-red-400' : r.paddingRate >= 0.1 ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}>{fmtPct(r.paddingRate, 0)}</td>
                            </tr>
                            {isOpen && (
                              <tr className="bg-muted/20 border-t border-border">
                                <td colSpan={13} className="px-3 py-2 space-y-3">
                                  <p className="text-[11px]">
                                    <span className="text-muted-foreground">Pipeline $: </span><span className="font-semibold">{fmtDollar(r.pipelineAmount)}</span>
                                    <span className="text-muted-foreground"> · Closed Won $: </span><span className="font-semibold">{fmtDollar(r.closedWonAmount)}</span>
                                    <span className="text-muted-foreground"> · Avg Deal Size (CW): </span><span className="font-semibold">{fmtDollar(r.closedWon > 0 ? r.closedWonAmount / r.closedWon : 0)}</span>
                                  </p>
                                  <div>
                                    <p className="text-[11px] font-semibold text-muted-foreground mb-1">Vintage breakdown by created quarter</p>
                                    {r.cohort.length === 0 ? <p className="text-[11px] text-muted-foreground">No data.</p> : (
                                      <table className="text-[11px]">
                                        <thead className="text-muted-foreground">
                                          <tr>
                                            <th className="text-left pr-4 py-0.5 font-medium">Quarter Created</th>
                                            <th className="text-right pr-4 py-0.5 font-medium">DRs</th>
                                            <th className="text-right pr-4 py-0.5 font-medium">SQL'd</th>
                                            <th className="text-right pr-4 py-0.5 font-medium">Closed Won</th>
                                            <th className="text-right pr-4 py-0.5 font-medium">Cohort Rate</th>
                                            <th className="text-right py-0.5 font-medium">Avg Cycle</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {r.cohort.map(c => (
                                            <tr key={c.quarter}>
                                              <td className="pr-4 py-0.5">{c.quarter}</td>
                                              <td className="text-right pr-4 py-0.5">{c.total}</td>
                                              <td className="text-right pr-4 py-0.5">{c.sql}</td>
                                              <td className="text-right pr-4 py-0.5">{c.closedWon}</td>
                                              <td className={`text-right pr-4 py-0.5 ${colorConvRate(c.cohortRate)}`}>{fmtPct(c.cohortRate, 0)}</td>
                                              <td className="text-right py-0.5">{c.avgCycle !== null ? `${c.avgCycle.toFixed(0)} days` : '—'}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    )}
                                  </div>
                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                      <p className="text-[11px] font-semibold text-muted-foreground mb-1">Rep breakdown</p>
                                      <table className="text-[11px] w-full">
                                        <thead className="text-muted-foreground">
                                          <tr>
                                            <th className="text-left pr-4 py-0.5 font-medium">Rep</th>
                                            <th className="text-right pr-4 py-0.5 font-medium">DRs</th>
                                            <th className="text-right pr-4 py-0.5 font-medium">SQL'd</th>
                                            <th className="text-right pr-4 py-0.5 font-medium">Closed Won</th>
                                            <th className="text-right py-0.5 font-medium">Cohort Rate</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {r.repBreakdown.map(rb => (
                                            <tr key={rb.rep}>
                                              <td className="pr-4 py-0.5">{rb.rep}</td>
                                              <td className="text-right pr-4 py-0.5">{rb.drs}</td>
                                              <td className="text-right pr-4 py-0.5">{rb.sqls}</td>
                                              <td className="text-right pr-4 py-0.5">{rb.closedWon}</td>
                                              <td className={`text-right py-0.5 ${colorConvRate(rb.cohortRate)}`}>{fmtPct(rb.cohortRate, 0)}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                    <div>
                                      <p className="text-[11px] font-semibold text-muted-foreground mb-1">CAM breakdown</p>
                                      <table className="text-[11px] w-full">
                                        <thead className="text-muted-foreground">
                                          <tr>
                                            <th className="text-left pr-4 py-0.5 font-medium">CAM</th>
                                            <th className="text-right pr-4 py-0.5 font-medium">DRs</th>
                                            <th className="text-right pr-4 py-0.5 font-medium">SQL'd</th>
                                            <th className="text-right pr-4 py-0.5 font-medium">Closed Won</th>
                                            <th className="text-right py-0.5 font-medium">Cohort Rate</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {r.camBreakdown.map(cb => (
                                            <tr key={cb.cam}>
                                              <td className="pr-4 py-0.5">{cb.cam}</td>
                                              <td className="text-right pr-4 py-0.5">{cb.drs}</td>
                                              <td className="text-right pr-4 py-0.5">{cb.sqls}</td>
                                              <td className="text-right pr-4 py-0.5">{cb.closedWon}</td>
                                              <td className={`text-right py-0.5 ${colorConvRate(cb.cohortRate)}`}>{fmtPct(cb.cohortRate, 0)}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </div>
                                  <div>
                                    <p className="text-[11px] font-semibold text-muted-foreground mb-1">Padded accounts</p>
                                    {r.paddedAccountsList.length === 0 ? (
                                      <p className="text-[11px] text-muted-foreground">No accounts with 2+ pre-SQL, no-activity DRs.</p>
                                    ) : (
                                      <table className="text-[11px] w-full">
                                        <thead className="text-muted-foreground">
                                          <tr>
                                            <th className="text-left pr-4 py-0.5 font-medium">Account</th>
                                            <th className="text-right pr-4 py-0.5 font-medium">DRs on Account</th>
                                            <th className="text-right pr-4 py-0.5 font-medium">Pre-SQL No-Activity</th>
                                            <th className="text-left py-0.5 font-medium">Products</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {r.paddedAccountsList.map(p => (
                                            <tr key={p.account}>
                                              <td className="pr-4 py-0.5">{p.account}</td>
                                              <td className="text-right pr-4 py-0.5">{p.drs}</td>
                                              <td className="text-right pr-4 py-0.5 text-red-600 dark:text-red-400 font-medium">{p.preSqlNoActivity}</td>
                                              <td className="py-0.5 text-muted-foreground">{p.products.join(', ') || '—'}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                      {resellerRows.length > 0 && (
                        <tr className="border-t-2 border-border font-medium bg-secondary/30">
                          <td className="px-2 py-1.5">Total</td>
                          <td className="text-right px-2 py-1.5">{resellerTotals.totalDrs}</td>
                          <td className={`text-right px-2 py-1.5 ${colorRate(resellerTotals.sqlRate)}`}>{fmtPct(resellerTotals.sqlRate, 0)}</td>
                          <td className="text-right px-2 py-1.5">{resellerTotals.closedWon}</td>
                          <td className={`text-right px-2 py-1.5 ${colorConvRate(resellerTotals.cohortRate)}`}>{fmtPct(resellerTotals.cohortRate, 0)}</td>
                          <td className="text-right px-2 py-1.5">{resellerTotals.avgCycle !== null ? `${resellerTotals.avgCycle.toFixed(0)} days` : '—'}</td>
                          <td className="text-right px-2 py-1.5">—</td>
                          <td className="text-right px-2 py-1.5">—</td>
                          <td className="text-right px-2 py-1.5">—</td>
                          <td className="px-2 py-1.5">—</td>
                          <td className="text-right px-2 py-1.5">{resellerTotals.paddedAccts}</td>
                          <td className={`text-right px-2 py-1.5 font-semibold ${resellerTotals.paddingRate >= 0.2 ? 'text-red-600 dark:text-red-400' : resellerTotals.paddingRate >= 0.1 ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}>{fmtPct(resellerTotals.paddingRate, 0)}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {resellerInsights.length > 0 && (
                  <div className="px-3 py-2 border-t border-border bg-secondary/20 space-y-1">
                    {resellerInsights.map((line, i) => <p key={i} className="text-xs">{line}</p>)}
                  </div>
                )}
              </>
            )}
          </section>




          {/* Section D: Funnel + Conversion timeline + Cohort */}
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="border border-border rounded-md">
              <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                <h3 className="text-xs font-semibold">Stage Funnel</h3>
                <div className="flex items-center gap-1 text-xs">
                  <button onClick={() => setFunnelMonthOffset(o => o - 1)} className="px-1 hover:text-foreground text-muted-foreground">←</button>
                  <span className="px-1">{funnelMonthOffset === 0 ? 'Active period' : funnelMonthLabel}</span>
                  <button onClick={() => setFunnelMonthOffset(o => o + 1)} disabled={funnelMonthOffset >= 0} className="px-1 hover:text-foreground text-muted-foreground disabled:opacity-30">→</button>
                  {funnelMonthOffset !== 0 && (
                    <button onClick={() => setFunnelMonthOffset(0)} className="ml-1 text-muted-foreground hover:text-foreground"><X size={11} /></button>
                  )}
                </div>
              </div>
              <div className="p-3 space-y-1.5">
                {stageRows.map((r, i) => (
                  <Fragment key={r.stage}>
                    {i === 2 && (
                      <div className="border-t border-dashed border-amber-500/40 my-2 relative">
                        <span className="absolute -top-2 right-0 text-[10px] text-amber-600 dark:text-amber-400 bg-background px-1">SQL threshold (25%)</span>
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-xs">
                      <span className="w-32 text-muted-foreground">{r.stage}</span>
                      <span className="w-10 text-right tabular-nums">{r.count}</span>
                      <div className="flex-1 h-3 bg-secondary rounded">
                        <div className="h-full bg-foreground/70 rounded" style={{ width: `${Math.min(100, r.pct * 100)}%` }} />
                      </div>
                      <span className="w-10 text-right tabular-nums text-muted-foreground">{fmtPct(r.pct)}</span>
                    </div>
                  </Fragment>
                ))}
              </div>
            </div>

            <div className="border border-border rounded-md">
              <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                <h3 className="text-xs font-semibold">Conversion Timeline</h3>
                <label className="text-xs flex items-center gap-1">
                  <span className="text-muted-foreground">Period:</span>
                  <select value={timelinePeriod} onChange={e => setTimelinePeriod(e.target.value as Period)} className="text-xs bg-background border border-border rounded px-1.5 py-1">
                    <option value="this-month">This month</option>
                    <option value="last-month">Last month</option>
                    <option value="this-quarter">This quarter</option>
                    <option value="last-quarter">Last quarter</option>
                    <option value="all">All time</option>
                  </select>
                </label>
              </div>
              <table className="w-full text-xs">
                <thead className="bg-secondary/40 text-muted-foreground">
                  <tr>
                    <th className="text-left px-2 py-1.5 font-medium">Milestone</th>
                    <th className="text-right px-2 py-1.5 font-medium">Avg Days</th>
                    <th className="text-right px-2 py-1.5 font-medium"># Deals</th>
                  </tr>
                </thead>
                <tbody>
                  {timeline.map(t => (
                    <tr key={t.label} className="border-t border-border">
                      <td className="px-2 py-1.5">{t.label}</td>
                      <td className="text-right px-2 py-1.5">{t.n >= 5 ? `${t.avg.toFixed(0)} days` : <span className="text-muted-foreground">Not enough data</span>}</td>
                      <td className="text-right px-2 py-1.5 text-muted-foreground">{t.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-3 py-2 border-t border-border bg-secondary/20">
                <p className="text-xs font-semibold mb-1.5">Cohort Conversion (last 4 months)</p>
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left py-1 font-medium">Month</th>
                      <th className="text-right py-1 font-medium">DRs</th>
                      <th className="text-right py-1 font-medium">SQL'd</th>
                      <th className="text-right py-1 font-medium">In Pipe</th>
                      <th className="text-right py-1 font-medium">Won</th>
                      <th className="text-right py-1 font-medium">Lost</th>
                      <th className="text-right py-1 font-medium">Cohort Rate</th>
                      <th className="text-right py-1 font-medium">Avg Cycle</th>
                      <th className="text-right py-1 font-medium">Active</th>
                      <th className="text-right py-1 font-medium">Padded</th>
                      <th className="text-right py-1 font-medium">Rejected</th>
                      <th className="text-right py-1 font-medium">Withdrawn</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cohortRows.map(r => (
                      <tr key={r.month} className="border-t border-border/50">
                        <td className="py-1">{r.month}</td>
                        <td className="text-right py-1">{r.total}</td>
                        <td className="text-right py-1">{r.sql}</td>
                        <td className="text-right py-1">{r.inPipe}</td>
                        <td className="text-right py-1 text-emerald-700 dark:text-emerald-400 font-medium">{r.won}</td>
                        <td className="text-right py-1 text-muted-foreground">{r.lost}</td>
                        <td className={`text-right py-1 font-medium ${colorConvRate(r.cohortRate)}`}>{fmtPct(r.cohortRate, 0)}</td>
                        <td className="text-right py-1">{r.avgCycle !== null ? `${r.avgCycle.toFixed(0)}d` : '—'}</td>
                        <td className="text-right py-1">{r.active}</td>
                        <td className={`text-right py-1 ${r.padded > 0 ? 'text-red-600 dark:text-red-400 font-medium' : 'text-muted-foreground'}`}>{r.padded}</td>
                        <td className="text-right py-1 text-muted-foreground">{r.rejected}</td>
                        <td className="text-right py-1 text-muted-foreground">{r.withdrawn}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-[10px] text-muted-foreground mt-1">Cohort rate for recent months will increase as deals in progress close. Avg Cycle reflects closed deals only.</p>
              </div>
            </div>
          </section>

          {/* Section E: Deal detail */}
          <section className="border border-border rounded-md">
            <div className="px-3 py-2 border-b border-border flex items-center gap-3">
              <h3 className="text-xs font-semibold">Deal Detail</h3>
              <span className="text-xs text-muted-foreground ml-auto">{detailRows.length} shown</span>
            </div>
            <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-secondary/40 text-muted-foreground sticky top-0">
                  <tr>
                    <th className="w-6"></th>
                    {sortHeader('account', 'Account')}
                    {sortHeader('opportunity', 'Opportunity')}
                    {sortHeader('rep', 'Rep')}
                    {sortHeader('cam', 'CAM')}
                    {sortHeader('stage', 'Stage')}
                    {sortHeader('age', 'Age', 'right')}
                    {sortHeader('lastActivity', 'Last Activity')}
                    {sortHeader('amount', 'Amount', 'right')}
                    {sortHeader('status', 'Status')}
                    {sortHeader('reseller', 'Reseller')}
                    <th className="text-right px-2 py-1.5 font-medium">Cycle</th>
                    <th className="text-center px-2 py-1.5 font-medium" title="Created and closed in the same quarter">In-Period</th>
                  </tr>
                </thead>
                <tbody>
                  {detailRows.map(d => {
                    const isOpen = expandedRow === d.opportunityId;
                    const matchOpp: Opportunity | undefined = oppMap.get(d.opportunityId);
                    return (
                      <Fragment key={d.opportunityId}>
                        <tr onClick={() => setExpandedRow(isOpen ? null : d.opportunityId)} className="border-t border-border cursor-pointer hover:bg-muted/40">
                          <td className="px-1 py-1.5">{isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</td>
                          <td className="px-2 py-1.5">{d.accountName || '—'}</td>
                          <td className="px-2 py-1.5">{d.opportunityName}</td>
                          <td className="px-2 py-1.5">{d.repName}</td>
                          <td className="px-2 py-1.5">{d.channelAccountManager || '—'}</td>
                          <td className="px-2 py-1.5">{d.stage}</td>
                          <td className={`text-right px-2 py-1.5 ${colorAge(d.ageDays)}`}>{d.ageDays}d</td>
                          <td className="px-2 py-1.5">{d.lastActivity || <span className="text-muted-foreground">—</span>}</td>
                          <td className="text-right px-2 py-1.5">
                            {d.amount ? (
                              currentlySql(d)
                                ? fmtMoney(d.amount)
                                : <span className="text-muted-foreground italic" title="Not counted in defensible value">{fmtMoney(d.amount)} <span className="text-[10px]">pre-discovery</span></span>
                            ) : '—'}
                          </td>
                          <td className="px-2 py-1.5"><span className={`px-1.5 py-0.5 rounded text-[10px] ${statusBadgeCls(d.status)}`}>{statusLabel(d.status)}</span></td>
                          <td className="px-2 py-1.5">{d.resellerName || '—'}</td>
                          <td className="text-right px-2 py-1.5">{d.status === 'closed_won' && typeof d.cycleDays === 'number' ? `${d.cycleDays} days` : <span className="text-muted-foreground">—</span>}</td>
                          <td className="text-center px-2 py-1.5">{d.inPeriodWon ? <span className="text-green-600 dark:text-green-400">✓</span> : <span className="text-muted-foreground">—</span>}</td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-muted/20 border-t border-border">
                            <td></td>
                            <td colSpan={12} className="px-3 py-3 space-y-2">
                              <StageTimeline d={d} />
                              {d.status === 'closed_won' && d.closedWonDate && (
                                <div className="text-xs">
                                  <span className="inline-block px-1.5 py-0.5 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 rounded text-[10px] font-medium mr-2">Closed Won ✓</span>
                                  <span className="text-muted-foreground">
                                    Closed: <span className="text-foreground">{d.closedWonDate}</span>
                                    {typeof d.cycleDays === 'number' && (<>{' · '}Cycle: <span className="text-foreground">{d.cycleDays} days</span></>)}
                                    {d.inPeriodWon && (<>{' · '}<span className="text-green-600 dark:text-green-400">In-period ✓</span></>)}
                                  </span>
                                </div>
                              )}
                              {matchOpp && d.status !== 'closed_won' && (
                                <div className="text-xs">
                                  <span className="inline-block px-1.5 py-0.5 bg-teal-500/15 text-teal-700 dark:text-teal-400 rounded text-[10px] font-medium mr-2">In Pipeline ✓</span>
                                  <span className="text-muted-foreground">
                                    Stage: <span className="text-foreground">{matchOpp.stage}</span>
                                    {' · '}Amount: <span className="text-foreground">{fmtMoney(matchOpp.amount)}</span>
                                    {' · '}Close: <span className="text-foreground">{matchOpp.closeDate || '—'}</span>
                                  </span>
                                </div>
                              )}
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                                <div><span className="text-muted-foreground">Opportunity ID:</span> {d.opportunityId}</div>
                                <div><span className="text-muted-foreground">Created:</span> {d.createdDate || '—'}</div>
                                <div><span className="text-muted-foreground">Close Date:</span> {d.closeDate || '—'}</div>
                                <div><span className="text-muted-foreground">SQL Date:</span> {d.sqlDate || '—'}</div>
                                <div><span className="text-muted-foreground">2nd Owner:</span> {d.secondOwner || '—'}</div>
                                <div><span className="text-muted-foreground">Distributor:</span> {d.distributorReseller || '—'}</div>
                                <div><span className="text-muted-foreground">Billing State:</span> {d.billingState || '—'}</div>
                                <div><span className="text-muted-foreground">Lead Source:</span> {d.leadSource || '—'}</div>
                                <div><span className="text-muted-foreground">Type:</span> {d.type || '—'}</div>
                                <div><span className="text-muted-foreground">Product:</span> {d.product || '—'}</div>
                                <div><span className="text-muted-foreground">First seen:</span> {new Date(d.firstSeenAt).toLocaleDateString()}</div>
                                <div><span className="text-muted-foreground">Last seen:</span> {new Date(d.lastSeenAt).toLocaleDateString()}</div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              {detailRows.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">No deals match filters.</p>}
            </div>
          </section>

          {/* Section F: Account Padding */}
          <section className="border border-border rounded-md">
            <div className="px-3 py-2 border-b border-border flex items-center gap-3">
              <h3 className="text-xs font-semibold">Account Padding Analysis</h3>
              <label className="text-xs flex items-center gap-1 ml-auto">
                <input type="checkbox" checked={showPaddedOnly} onChange={e => setShowPaddedOnly(e.target.checked)} />
                Show padded only
              </label>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-secondary/40 text-muted-foreground">
                  <tr>
                    <th className="text-left px-2 py-1.5 font-medium">Account</th>
                    <th className="text-left px-2 py-1.5 font-medium">AE(s)</th>
                    <th className="text-left px-2 py-1.5 font-medium">CAM(s)</th>
                    <th className="text-right px-2 py-1.5 font-medium">Total DRs</th>
                    <th className="text-right px-2 py-1.5 font-medium">Pre-SQL</th>
                    <th className="text-right px-2 py-1.5 font-medium">SQL</th>
                    <th className="text-left px-2 py-1.5 font-medium">Padded?</th>
                    <th className="text-left px-2 py-1.5 font-medium">Products</th>
                  </tr>
                </thead>
                <tbody>
                  {accountRows.map(a => {
                    const multiCam = a.cams.length > 1;
                    const multiRep = a.reps.length > 1;
                    const paddedColor = a.padded === 'yes' ? 'bg-red-500/15 text-red-700 dark:text-red-400'
                      : a.padded === 'maybe' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                      : 'bg-green-500/15 text-green-700 dark:text-green-400';
                    return (
                      <tr key={a.account} className="border-t border-border">
                        <td className="px-2 py-1.5 font-medium">{a.account}</td>
                        <td className={`px-2 py-1.5 ${multiRep ? 'text-amber-600 dark:text-amber-400 font-medium' : ''}`}>{a.reps.join(', ')}{multiRep && ' ⚠'}</td>
                        <td className={`px-2 py-1.5 ${multiCam ? 'text-amber-600 dark:text-amber-400' : ''}`}>{a.cams.join(', ')}</td>
                        <td className="text-right px-2 py-1.5">{a.total}</td>
                        <td className="text-right px-2 py-1.5">{a.preSql}</td>
                        <td className="text-right px-2 py-1.5">{a.sql}</td>
                        <td className="px-2 py-1.5"><span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${paddedColor}`}>{a.padded === 'yes' ? 'Yes' : a.padded === 'maybe' ? 'Maybe' : 'No'}</span></td>
                        <td className="px-2 py-1.5 text-muted-foreground">{a.products.join(', ') || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {accountRows.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">No multi-DR accounts.</p>}
            </div>
          </section>

          {/* Data Hygiene: No Reseller */}
          <section className="border border-border rounded-md">
            <div className="px-3 py-2 border-b border-border flex items-center gap-3">
              <h3 className="text-xs font-semibold">Data Hygiene — Missing Reseller</h3>
              <span className="text-xs text-muted-foreground ml-auto">{noResellerRows.length} open registrations</span>
            </div>
            <p className="text-[11px] text-muted-foreground px-3 pt-2">Add reseller or distributor on these opportunities in Salesforce.</p>
            <div className="overflow-x-auto max-h-80 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-secondary/40 text-muted-foreground sticky top-0">
                  <tr>
                    <th className="text-left px-2 py-1.5 font-medium">Account</th>
                    <th className="text-left px-2 py-1.5 font-medium">Opportunity</th>
                    <th className="text-left px-2 py-1.5 font-medium">CAM</th>
                    <th className="text-left px-2 py-1.5 font-medium">Stage</th>
                    <th className="text-left px-2 py-1.5 font-medium">Opportunity ID</th>
                  </tr>
                </thead>
                <tbody>
                  {noResellerRows.map(d => (
                    <tr key={d.opportunityId} className="border-t border-border">
                      <td className="px-2 py-1.5">{d.accountName || '—'}</td>
                      <td className="px-2 py-1.5">{d.opportunityName}</td>
                      <td className="px-2 py-1.5">{d.channelAccountManager || '—'}</td>
                      <td className="px-2 py-1.5">{d.stage}</td>
                      <td className="px-2 py-1.5 font-mono text-[10px]">{d.opportunityId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {noResellerRows.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">All open registrations have a reseller assigned. ✓</p>}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
