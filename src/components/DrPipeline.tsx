import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Upload, FileSpreadsheet, Download, RefreshCw, X, ChevronDown, ChevronRight } from 'lucide-react';
import * as XLSX from '@e965/xlsx';
import { parseDrExport } from '@/lib/drParser';
import { mergeDrBatch } from '@/lib/drMerge';
import type { DealRegistration, RawDrRecord, DrStatus, Opportunity } from '@/types/forecast';

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
function fmtPct(n: number, digits = 0): string { return `${(n * 100).toFixed(digits)}%`; }

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
      const { records, asOfDate, errors } = parseDrExport(rows);
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
    preview: { newCount: number; updatedCount: number; rejectedCount: number; convertedCount: number };
  } | null>(null);

  // Global filters
  const [camFilter, setCamFilter] = useState<string>('all');
  const [repFilter, setRepFilter] = useState<string>('all');
  const [period, setPeriod] = useState<Period>(DEFAULT_PERIOD);
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

  const filtered = useMemo(() => {
    return dealRegistrations.filter(d => {
      if (camFilter !== 'all' && (d.channelAccountManager || '(none)') !== camFilter) return false;
      if (repFilter !== 'all' && d.repName !== repFilter) return false;
      if (!inRange(d.createdDate, periodRange)) return false;
      if (statuses.size > 0 && !statuses.has(d.status)) return false;
      return true;
    });
  }, [dealRegistrations, camFilter, repFilter, periodRange, statuses]);

  // Section-B "scope" ignores statuses (so all rows show) but applies cam/rep/period
  const scopeNoStatus = useMemo(() => {
    return dealRegistrations.filter(d => {
      if (camFilter !== 'all' && (d.channelAccountManager || '(none)') !== camFilter) return false;
      if (repFilter !== 'all' && d.repName !== repFilter) return false;
      if (!inRange(d.createdDate, periodRange)) return false;
      return true;
    });
  }, [dealRegistrations, camFilter, repFilter, periodRange]);

  const defaultStatusesActive = DEFAULT_STATUSES.length === statuses.size && DEFAULT_STATUSES.every(s => statuses.has(s));
  const filtersActive = camFilter !== 'all' || repFilter !== 'all' || period !== DEFAULT_PERIOD || !defaultStatusesActive;
  const clearFilters = () => { setCamFilter('all'); setRepFilter('all'); setPeriod(DEFAULT_PERIOD); setStatuses(new Set(DEFAULT_STATUSES)); };

  // ---------- Section B: AE Accountability ----------
  type AeRow = {
    rep: string; assigned: number; rejected: number; sqls: number; sqlRate: number;
    stale: number; noActivity: number; avgAge: number;
    converted: number; closedWon: number; convRate: number;
    rejectedByCam: Map<string, { count: number; products: string[] }>;
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
      const sqls = nonRejected.filter(d => d.isSql).length;
      const sqlRate = denom ? sqls / denom : 0;
      const stale = nonRejected.filter(d => d.status === 'stale').length;
      const noActivity = nonRejected.filter(d => !d.lastActivity && (d.status === 'active' || d.status === 'stale')).length;
      const avgAge = denom ? nonRejected.reduce((s, d) => s + d.ageDays, 0) / denom : 0;
      const converted = nonRejected.filter(d => d.status === 'converted' || d.status === 'closed_won' || d.status === 'closed_lost').length;
      const closedWon = nonRejected.filter(d => d.status === 'closed_won').length;
      const convRate = denom ? closedWon / denom : 0;
      const rejectedByCam = new Map<string, { count: number; products: string[] }>();
      for (const d of deals) {
        if (d.status !== 'rejected') continue;
        const cam = d.channelAccountManager || '(none)';
        const e = rejectedByCam.get(cam) || { count: 0, products: [] };
        e.count++;
        if (d.product && !e.products.includes(d.product)) e.products.push(d.product);
        rejectedByCam.set(cam, e);
      }
      return { rep, assigned, rejected, sqls, sqlRate, stale, noActivity, avgAge, converted, closedWon, convRate, rejectedByCam };
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
      return acc;
    }, { assigned: 0, rejected: 0, nonRejected: 0, sqls: 0, stale: 0, noActivity: 0, converted: 0, closedWon: 0, ageSum: 0 });
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

  // ---------- Section C: CAM Lead Quality ----------
  type CamRow = {
    cam: string; registered: number; sqls: number; sqlRate: number;
    paddedAccts: number; withdrawn: number; withdrawnRate: number;
    avgAgeAtSql: number; closedWon: number; winRate: number;
  };
  const camRows: CamRow[] = useMemo(() => {
    const byCam = new Map<string, DealRegistration[]>();
    for (const d of scopeNoStatus) {
      const k = d.channelAccountManager || '(none)';
      const arr = byCam.get(k) || [];
      arr.push(d);
      byCam.set(k, arr);
    }
    return Array.from(byCam.entries()).map(([cam, deals]) => {
      const registered = deals.length;
      const sqls = deals.filter(d => d.isSql).length;
      const sqlRate = registered ? sqls / registered : 0;
      // padded accts: account with 2+ DRs all pre-SQL with no lastActivity (exclude rejected)
      const byAcct = new Map<string, DealRegistration[]>();
      for (const d of deals) {
        if (d.status === 'rejected') continue;
        const a = (d.accountName || '(none)').toLowerCase();
        const arr = byAcct.get(a) || []; arr.push(d); byAcct.set(a, arr);
      }
      let paddedAccts = 0;
      for (const arr of byAcct.values()) {
        if (arr.length >= 2 && arr.every(d => !d.isSql && !d.lastActivity)) paddedAccts++;
      }
      const withdrawn = deals.filter(d => d.status === 'withdrawn').length;
      const withdrawnRate = registered ? withdrawn / registered : 0;
      const sqlDeals = deals.filter(d => d.sqlDate);
      const avgAgeAtSql = sqlDeals.length
        ? sqlDeals.reduce((s, d) => s + daysBetween(d.createdDate, d.sqlDate!), 0) / sqlDeals.length
        : 0;
      const closedWon = deals.filter(d => d.status === 'closed_won').length;
      const winRate = registered ? closedWon / registered : 0;
      return { cam, registered, sqls, sqlRate, paddedAccts, withdrawn, withdrawnRate, avgAgeAtSql, closedWon, winRate };
    }).sort((a, b) => b.registered - a.registered);
  }, [scopeNoStatus]);

  const camInsights = useMemo(() => {
    const out: string[] = [];
    for (const r of camRows) if (r.withdrawnRate > 0.2 && r.withdrawn > 2) out.push(`⚠ ${r.cam} has ${r.withdrawn} withdrawn DRs (${fmtPct(r.withdrawnRate, 0)}) — registrations disappearing without conversion.`);
    return out;
  }, [camRows]);

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
    const toSql = filtered.filter(d => d.sqlDate && d.createdDate).map(d => daysBetween(d.createdDate, d.sqlDate!));
    const toConv = filtered.filter(d => d.convertedAt && d.createdDate).map(d => daysBetween(d.createdDate, d.convertedAt!));
    const toWon = filtered.filter(d => d.status === 'closed_won' && d.createdDate)
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
  }, [filtered, opportunities]);

  // Cohort: last 4 months of createdDate
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
      const won = deals.filter(d => d.status === 'closed_won').length;
      const active = deals.filter(d => d.status === 'active' || d.status === 'sql' || d.status === 'stale' || d.status === 'padded').length;
      const rejected = deals.filter(d => d.status === 'rejected').length;
      return { month: m.label, total: deals.length, sql, inPipe, won, active, rejected };
    });
  }, [dealRegistrations]);

  // ---------- Section E: Detail table ----------
  const oppMap = useMemo(() => new Map(opportunities.map(o => [o.id, o])), [opportunities]);

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

  // ---------- Section F: Account Padding ----------
  const accountRows = useMemo(() => {
    const byAcct = new Map<string, DealRegistration[]>();
    for (const d of filtered) {
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
    importDrBatch(pending.records, {
      fileName: pending.fileName,
      asOfDate: pending.asOfDate,
      importedAt: new Date().toISOString(),
    });
    setPending(null); setShowUploader(false);
    toast({ title: 'DR batch merged', description: `${pending.preview.newCount} new · ${pending.preview.updatedCount} updated · ${pending.preview.convertedCount} converted · ${pending.preview.rejectedCount} rejected` });
  };

  // ---------- Export ----------
  const exportReport = () => {
    const wb = XLSX.utils.book_new();
    const aeSheet = XLSX.utils.json_to_sheet(aeRows.map(r => ({
      Rep: r.rep, 'Assigned DRs': r.assigned, Rejected: r.rejected, "SQL'd": r.sqls, 'SQL Rate': fmtPct(r.sqlRate, 1),
      Stale: r.stale, 'No Activity': r.noActivity, 'Avg Age': r.avgAge.toFixed(1),
      Converted: r.converted, 'Closed Won': r.closedWon, 'Conv. Rate': fmtPct(r.convRate, 1),
    })));
    XLSX.utils.book_append_sheet(wb, aeSheet, 'AE Summary');

    const camSheet = XLSX.utils.json_to_sheet(camRows.map(r => ({
      CAM: r.cam, 'DRs Registered': r.registered, 'SQL Rate': fmtPct(r.sqlRate, 1),
      'Padded Accts': r.paddedAccts, Withdrawn: r.withdrawn, 'Withdrawn Rate': fmtPct(r.withdrawnRate, 1),
      'Avg Age at SQL': r.avgAgeAtSql.toFixed(1), 'Closed Won': r.closedWon, 'Win Rate': fmtPct(r.winRate, 1),
    })));
    XLSX.utils.book_append_sheet(wb, camSheet, 'CAM Summary');

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

    XLSX.writeFile(wb, `DR_Pipeline_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

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
                    <th className="text-right px-2 py-1.5 font-medium">Assigned DRs</th>
                    <th className="text-right px-2 py-1.5 font-medium">SQL'd</th>
                    <th className="text-right px-2 py-1.5 font-medium">SQL Rate</th>
                    <th className="text-right px-2 py-1.5 font-medium">Stale</th>
                    <th className="text-right px-2 py-1.5 font-medium">No Activity</th>
                    <th className="text-right px-2 py-1.5 font-medium">Avg Age</th>
                    <th className="text-right px-2 py-1.5 font-medium">Converted</th>
                    <th className="text-right px-2 py-1.5 font-medium">Closed Won</th>
                    <th className="text-right px-2 py-1.5 font-medium">Conv. Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {aeRows.map(r => (
                    <tr key={r.rep}
                      onClick={() => setExpandedRep(expandedRep === r.rep ? null : r.rep)}
                      className={`border-t border-border cursor-pointer hover:bg-muted/40 ${expandedRep === r.rep ? 'bg-muted/60' : ''}`}>
                      <td className="px-2 py-1.5 font-medium">{r.rep}</td>
                      <td className="text-right px-2 py-1.5">{r.assigned}</td>
                      <td className="text-right px-2 py-1.5">{r.sqls}</td>
                      <td className={`text-right px-2 py-1.5 font-medium ${colorRate(r.sqlRate)}`}>{fmtPct(r.sqlRate, 1)}</td>
                      <td className={`text-right px-2 py-1.5 ${r.stale > 0 ? 'text-red-600 dark:text-red-400 font-medium' : ''}`}>{r.stale}</td>
                      <td className={`text-right px-2 py-1.5 ${r.noActivity > 3 ? 'text-amber-600 dark:text-amber-400 font-medium' : ''}`}>{r.noActivity}</td>
                      <td className={`text-right px-2 py-1.5 ${colorAge(r.avgAge)}`}>{r.avgAge.toFixed(0)}d</td>
                      <td className="text-right px-2 py-1.5">{r.converted}</td>
                      <td className="text-right px-2 py-1.5 font-semibold text-emerald-700 dark:text-emerald-400">{r.closedWon}</td>
                      <td className={`text-right px-2 py-1.5 font-medium ${colorConvRate(r.convRate)}`}>{fmtPct(r.convRate, 1)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-border font-medium bg-secondary/30">
                    <td className="px-2 py-1.5">Team</td>
                    <td className="text-right px-2 py-1.5">{aeTotals.assigned}</td>
                    <td className="text-right px-2 py-1.5">{aeTotals.sqls}</td>
                    <td className={`text-right px-2 py-1.5 ${colorRate(aeTotals.sqlRate)}`}>{fmtPct(aeTotals.sqlRate, 1)}</td>
                    <td className="text-right px-2 py-1.5">{aeTotals.stale}</td>
                    <td className="text-right px-2 py-1.5">{aeTotals.noActivity}</td>
                    <td className={`text-right px-2 py-1.5 ${colorAge(aeTotals.avgAge)}`}>{aeTotals.avgAge.toFixed(0)}d</td>
                    <td className="text-right px-2 py-1.5">{aeTotals.converted}</td>
                    <td className="text-right px-2 py-1.5">{aeTotals.closedWon}</td>
                    <td className={`text-right px-2 py-1.5 ${colorConvRate(aeTotals.convRate)}`}>{fmtPct(aeTotals.convRate, 1)}</td>
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

          {/* Section C: CAM Lead Quality (collapsible) */}
          <section className="border border-border rounded-md">
            <button onClick={() => setShowCam(s => !s)} className="w-full px-3 py-2 flex items-center justify-between hover:bg-muted/30">
              <h3 className="text-xs font-semibold flex items-center gap-1.5">
                {showCam ? <ChevronDown size={12} /> : <ChevronRight size={12} />} CAM Lead Quality
              </h3>
              <span className="text-xs text-muted-foreground">{camRows.length} CAMs</span>
            </button>
            {showCam && (
              <>
                <div className="overflow-x-auto border-t border-border">
                  <table className="w-full text-xs">
                    <thead className="bg-secondary/40 text-muted-foreground">
                      <tr>
                        <th className="text-left px-2 py-1.5 font-medium">CAM</th>
                        <th className="text-right px-2 py-1.5 font-medium">DRs Registered</th>
                        <th className="text-right px-2 py-1.5 font-medium">SQL Rate</th>
                        <th className="text-right px-2 py-1.5 font-medium">Padded Accts</th>
                        <th className="text-right px-2 py-1.5 font-medium">Rejected</th>
                        <th className="text-right px-2 py-1.5 font-medium">Avg Age at SQL</th>
                        <th className="text-right px-2 py-1.5 font-medium">Closed Won</th>
                        <th className="text-right px-2 py-1.5 font-medium">Win Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {camRows.map(r => (
                        <tr key={r.cam} className="border-t border-border">
                          <td className="px-2 py-1.5 font-medium">{r.cam}</td>
                          <td className="text-right px-2 py-1.5">{r.registered}</td>
                          <td className={`text-right px-2 py-1.5 font-medium ${colorRate(r.sqlRate)}`}>{fmtPct(r.sqlRate, 1)}</td>
                          <td className={`text-right px-2 py-1.5 ${r.paddedAccts > 0 ? 'text-red-600 dark:text-red-400 font-medium' : ''}`}>{r.paddedAccts}</td>
                          <td className={`text-right px-2 py-1.5 ${r.rejected > 2 ? 'text-amber-600 dark:text-amber-400' : ''}`}>{r.rejected}</td>
                          <td className="text-right px-2 py-1.5">{r.avgAgeAtSql ? `${r.avgAgeAtSql.toFixed(0)}d` : '—'}</td>
                          <td className="text-right px-2 py-1.5">{r.closedWon}</td>
                          <td className={`text-right px-2 py-1.5 font-medium ${colorConvRate(r.winRate)}`}>{fmtPct(r.winRate, 1)}</td>
                        </tr>
                      ))}
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
              <div className="px-3 py-2 border-b border-border">
                <h3 className="text-xs font-semibold">Conversion Timeline</h3>
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
                      <th className="text-right py-1 font-medium">Active</th>
                      <th className="text-right py-1 font-medium">Rejected</th>
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
                        <td className="text-right py-1">{r.active}</td>
                        <td className="text-right py-1 text-muted-foreground">{r.rejected}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
                          <td className="text-right px-2 py-1.5">{d.amount ? fmtMoney(d.amount) : '—'}</td>
                          <td className="px-2 py-1.5"><span className={`px-1.5 py-0.5 rounded text-[10px] ${statusBadgeCls(d.status)}`}>{statusLabel(d.status)}</span></td>
                          <td className="px-2 py-1.5">{d.resellerName || '—'}</td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-muted/20 border-t border-border">
                            <td></td>
                            <td colSpan={10} className="px-3 py-3 space-y-2">
                              <StageTimeline d={d} />
                              {matchOpp && (
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
        </>
      )}
    </div>
  );
}
