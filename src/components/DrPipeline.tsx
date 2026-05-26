import { Fragment as FragmentWithKey, useCallback, useMemo, useRef, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Upload, FileSpreadsheet, Download, RefreshCw, X, ChevronDown, ChevronRight } from 'lucide-react';
import * as XLSX from '@e965/xlsx';
import { parseDrExport } from '@/lib/drParser';
import type { DealRegistration, DrBatch } from '@/types/forecast';
import { getQuarter, getCurrentQuarter } from '@/types/forecast';

// ---------- Staleness ----------
function isStale(d: DealRegistration): boolean {
  const age = d.ageDays;
  const prob = d.probability;
  const stage = (d.stage || '').toLowerCase();
  if (stage.includes('unqualified') && age > 21) return true;
  if (prob < 0.1 && age > 30) return true; // Qualified 5%
  if (prob >= 0.25) {
    // Discovery 25%+: stale if >45d AND no last activity
    if (age > 45 && !d.lastActivity) return true;
  }
  return false;
}

function fmtMoney(n: number): string {
  if (!n) return '$0';
  if (Math.abs(n) >= 1000000) return `$${(n / 1000000).toFixed(1)}M`;
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`;
}

const STAGE_ORDER = ['Unqualified', 'Qualified 5%', 'Discovery 25%', 'Technical 50%', 'Commercial 75%', 'Purchasing 90%'];

function normalizeStage(s: string): string {
  const low = (s || '').toLowerCase();
  for (const st of STAGE_ORDER) {
    if (low.includes(st.toLowerCase().split(' ')[0])) return st;
  }
  return s || 'Unknown';
}

// ---------- Upload zone ----------
function UploadZone({ onParsed }: { onParsed: (records: Omit<DealRegistration, 'importedAt' | 'batchId'>[], asOfDate: string, fileName: string, errors: string[]) => void }) {
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
      onDrop={e => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (f) handleFile(f);
      }}
      onClick={() => inputRef.current?.click()}
      className="border-2 border-dashed border-border rounded-lg p-8 text-center cursor-pointer hover:border-foreground/30 transition-colors"
    >
      <Upload size={24} className="mx-auto mb-2 text-muted-foreground" />
      <p className="text-sm font-medium">Upload Salesforce DR Report</p>
      <p className="text-xs text-muted-foreground mt-1">Upload the "Deal Registrations - VAR NA" report. Each upload replaces the previous snapshot.</p>
      {parsing && <p className="text-xs text-muted-foreground mt-2">Parsing…</p>}
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx"
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          if (inputRef.current) inputRef.current.value = '';
        }}
      />
    </div>
  );
}

// ---------- Main ----------
export default function DrPipeline() {
  const { dealRegistrations, drBatches, opportunities, importDrBatch, clearDrData } = useForecast();
  const { toast } = useToast();

  const [showUploader, setShowUploader] = useState(false);
  const [pending, setPending] = useState<{ records: Omit<DealRegistration, 'importedAt' | 'batchId'>[]; asOfDate: string; fileName: string; errors: string[] } | null>(null);

  // Global filters
  const [camFilter, setCamFilter] = useState<string>('all');
  const [repFilter, setRepFilter] = useState<string>('all');
  const [quarterFilter, setQuarterFilter] = useState<string>(getCurrentQuarter());

  // Detail table state
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [staleOnly, setStaleOnly] = useState(false);
  const [sortKey, setSortKey] = useState<string>('ageDays');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [expandedCam, setExpandedCam] = useState<string | null>(null);
  const [showPaddedOnly, setShowPaddedOnly] = useState(false);

  // Available quarters
  const allQuarters = useMemo(() => {
    const set = new Set<string>();
    for (const d of dealRegistrations) {
      if (d.createdDate) set.add(getQuarter(d.createdDate));
    }
    return Array.from(set).sort();
  }, [dealRegistrations]);

  // Apply global filters
  const filtered = useMemo(() => {
    return dealRegistrations.filter(d => {
      if (camFilter !== 'all' && (d.channelAccountManager || '(none)') !== camFilter) return false;
      if (repFilter !== 'all' && d.repName !== repFilter) return false;
      if (quarterFilter !== 'all' && d.createdDate && getQuarter(d.createdDate) !== quarterFilter) return false;
      return true;
    });
  }, [dealRegistrations, camFilter, repFilter, quarterFilter]);

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

  // ----- CAM Funnel (Section B) -----
  const camRows = useMemo(() => {
    const byCam = new Map<string, DealRegistration[]>();
    for (const d of filtered) {
      const k = d.channelAccountManager || '(none)';
      const arr = byCam.get(k) || [];
      arr.push(d);
      byCam.set(k, arr);
    }
    const rows = Array.from(byCam.entries()).map(([cam, deals]) => {
      const sqls = deals.filter(d => d.isSql).length;
      const sqlRate = deals.length ? sqls / deals.length : 0;
      const stale = deals.filter(isStale).length;
      const accounts = new Set(deals.map(d => d.accountName).filter(Boolean)).size;
      // Padded accounts: account with 2+ DRs where ALL are pre-SQL
      const byAcct = new Map<string, DealRegistration[]>();
      for (const d of deals) {
        const a = d.accountName || '(none)';
        const arr = byAcct.get(a) || [];
        arr.push(d);
        byAcct.set(a, arr);
      }
      let padded = 0;
      for (const arr of byAcct.values()) {
        if (arr.length >= 2 && arr.every(d => !d.isSql)) padded++;
      }
      const avgAge = deals.length ? deals.reduce((s, d) => s + d.ageDays, 0) / deals.length : 0;
      const pipeline = deals.reduce((s, d) => s + (d.amount && d.amount > 0 ? d.amount : 0), 0);
      return { cam, deals, count: deals.length, sqls, sqlRate, stale, accounts, padded, avgAge, pipeline };
    });
    rows.sort((a, b) => a.sqlRate - b.sqlRate);
    return rows;
  }, [filtered]);

  const camTotals = useMemo(() => {
    const total = filtered.length;
    const sqls = filtered.filter(d => d.isSql).length;
    const rate = total ? sqls / total : 0;
    const stale = filtered.filter(isStale).length;
    const pipeline = filtered.reduce((s, d) => s + (d.amount && d.amount > 0 ? d.amount : 0), 0);
    return { total, sqls, rate, stale, pipeline };
  }, [filtered]);

  // Insight line
  const insights = useMemo(() => {
    const lines: string[] = [];
    for (const r of camRows) {
      if (r.count > 10 && r.sqlRate < 0.2) {
        lines.push(`⚠ ${r.cam} has registered ${r.count} DRs with only ${fmtPct(r.sqlRate)} converting to SQL — review lead quality in next QBR.`);
      }
      if (r.padded > 3) {
        lines.push(`⚠ ${r.cam} has ${r.padded} accounts with multiple pre-SQL registrations — possible padding pattern.`);
      }
    }
    if (camTotals.rate > 0.4) {
      lines.push(`✓ Overall SQL conversion rate is healthy at ${fmtPct(camTotals.rate)}.`);
    }
    return lines;
  }, [camRows, camTotals.rate]);

  // ----- Stage funnel (Section C) -----
  const stageRows = useMemo(() => {
    const total = filtered.length || 1;
    const byStage = new Map<string, DealRegistration[]>();
    for (const d of filtered) {
      const s = normalizeStage(d.stage);
      const arr = byStage.get(s) || [];
      arr.push(d);
      byStage.set(s, arr);
    }
    return STAGE_ORDER.map(stage => {
      const deals = byStage.get(stage) || [];
      const stale = deals.filter(isStale);
      const avgStaleAge = stale.length ? stale.reduce((s, d) => s + d.ageDays, 0) / stale.length : 0;
      return {
        stage,
        count: deals.length,
        pct: deals.length / total,
        stale: stale.length,
        stalePct: deals.length ? stale.length / deals.length : 0,
        avgStaleAge,
      };
    });
  }, [filtered]);

  const staleTotal = useMemo(() => {
    const stale = filtered.filter(isStale);
    return {
      count: stale.length,
      value: stale.reduce((s, d) => s + (d.amount || 0), 0),
    };
  }, [filtered]);

  // ----- Detail rows (Section D) -----
  const detailRows = useMemo(() => {
    const byAcctCam = new Map<string, DealRegistration[]>();
    for (const d of filtered) {
      const k = `${d.channelAccountManager || '(none)'}||${d.accountName || '(none)'}`;
      const arr = byAcctCam.get(k) || [];
      arr.push(d);
      byAcctCam.set(k, arr);
    }
    const oppMap = new Map(opportunities.map(o => [o.id, o]));
    let rows = filtered.map(d => {
      const stale = isStale(d);
      const key = `${d.channelAccountManager || '(none)'}||${d.accountName || '(none)'}`;
      const group = byAcctCam.get(key) || [];
      const preSqlInGroup = group.filter(x => !x.isSql);
      const padded = !d.isSql && preSqlInGroup.length >= 2;
      const status: string[] = [];
      if (d.isSql) status.push('SQL');
      else if (stale) status.push('Stale');
      else status.push('Active');
      if (padded) status.push('Padded');
      const matchOpp = oppMap.get(d.opportunityId);
      return { d, stale, padded, status, matchOpp };
    });

    if (expandedCam) rows = rows.filter(r => (r.d.channelAccountManager || '(none)') === expandedCam);
    if (stageFilter !== 'all') rows = rows.filter(r => normalizeStage(r.d.stage) === stageFilter);
    if (statusFilter !== 'all') rows = rows.filter(r => r.status.includes(statusFilter));
    if (staleOnly) rows = rows.filter(r => r.stale);

    rows.sort((a, b) => {
      let av: any, bv: any;
      switch (sortKey) {
        case 'account': av = a.d.accountName; bv = b.d.accountName; break;
        case 'name': av = a.d.opportunityName; bv = b.d.opportunityName; break;
        case 'rep': av = a.d.repName; bv = b.d.repName; break;
        case 'cam': av = a.d.channelAccountManager || ''; bv = b.d.channelAccountManager || ''; break;
        case 'stage': av = a.d.stage; bv = b.d.stage; break;
        case 'probability': av = a.d.probability; bv = b.d.probability; break;
        case 'amount': av = a.d.amount || 0; bv = b.d.amount || 0; break;
        case 'lastActivity': av = a.d.lastActivity || ''; bv = b.d.lastActivity || ''; break;
        case 'reseller': av = a.d.resellerName || ''; bv = b.d.resellerName || ''; break;
        default: av = a.d.ageDays; bv = b.d.ageDays;
      }
      if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return rows;
  }, [filtered, opportunities, stageFilter, statusFilter, staleOnly, sortKey, sortDir, expandedCam]);

  // ----- Account padding (Section E) -----
  const accountRows = useMemo(() => {
    const byAcct = new Map<string, DealRegistration[]>();
    for (const d of filtered) {
      const a = d.accountName || '(none)';
      const arr = byAcct.get(a) || [];
      arr.push(d);
      byAcct.set(a, arr);
    }
    let rows = Array.from(byAcct.entries())
      .filter(([_, arr]) => arr.length >= 2)
      .map(([account, arr]) => {
        const cams = Array.from(new Set(arr.map(d => d.channelAccountManager || '(none)')));
        const preSql = arr.filter(d => !d.isSql).length;
        const sql = arr.filter(d => d.isSql).length;
        const padded: 'yes' | 'maybe' | 'no' = arr.every(d => !d.isSql) ? 'yes' : arr.every(d => d.isSql) ? 'no' : 'maybe';
        const products = Array.from(new Set(arr.map(d => d.product).filter(Boolean))) as string[];
        return { account, cams, total: arr.length, preSql, sql, padded, products };
      });
    if (showPaddedOnly) rows = rows.filter(r => r.padded === 'yes');
    rows.sort((a, b) => b.total - a.total);
    return rows;
  }, [filtered, showPaddedOnly]);

  // ----- Confirm import -----
  const confirmImport = () => {
    if (!pending) return;
    const batchId = crypto.randomUUID();
    const importedAt = new Date().toISOString();
    const records: DealRegistration[] = pending.records.map(r => ({ ...r, batchId, importedAt }));
    const batch: DrBatch = {
      id: batchId,
      importedAt,
      fileName: pending.fileName,
      recordCount: records.length,
      asOfDate: pending.asOfDate,
    };
    importDrBatch(records, batch);
    setPending(null);
    setShowUploader(false);
    toast({ title: 'DR snapshot imported', description: `${records.length} records · As of ${pending.asOfDate}` });
  };

  // ----- Export -----
  const exportReport = () => {
    const wb = XLSX.utils.book_new();
    const camSheet = XLSX.utils.json_to_sheet(camRows.map(r => ({
      CAM: r.cam,
      DRs: r.count,
      SQLs: r.sqls,
      'SQL Rate': fmtPct(r.sqlRate, 1),
      'Stale DRs': r.stale,
      Accounts: r.accounts,
      'Padded Accts': r.padded,
      'Avg Age': r.avgAge.toFixed(1),
      'Pipeline $': r.pipeline,
    })));
    XLSX.utils.book_append_sheet(wb, camSheet, 'CAM Summary');

    const staleDeals = filtered.filter(isStale).sort((a, b) => b.ageDays - a.ageDays);
    const staleSheet = XLSX.utils.json_to_sheet(staleDeals.map(d => ({
      Account: d.accountName,
      Opportunity: d.opportunityName,
      Rep: d.repName,
      CAM: d.channelAccountManager || '',
      Stage: d.stage,
      Probability: d.probability,
      Amount: d.amount || 0,
      'Age (days)': d.ageDays,
      'Last Activity': d.lastActivity || '',
      'Close Date': d.closeDate || '',
    })));
    XLSX.utils.book_append_sheet(wb, staleSheet, 'Stale Deals');

    const acctSheet = XLSX.utils.json_to_sheet(accountRows.map(a => ({
      Account: a.account,
      'CAM(s)': a.cams.join('; '),
      'Total DRs': a.total,
      'Pre-SQL DRs': a.preSql,
      'SQL DRs': a.sql,
      Padded: a.padded,
      Products: a.products.join('; '),
    })));
    XLSX.utils.book_append_sheet(wb, acctSheet, 'Account Padding');

    const today = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `DR_Pipeline_${today}.xlsx`);
  };

  const lastBatch = drBatches[drBatches.length - 1];
  const hasData = dealRegistrations.length > 0;
  const filtersActive = camFilter !== 'all' || repFilter !== 'all' || quarterFilter !== getCurrentQuarter();

  const sortHeader = (key: string, label: string) => (
    <th
      className="text-left px-2 py-1.5 font-medium cursor-pointer hover:text-foreground select-none"
      onClick={() => {
        if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        else { setSortKey(key); setSortDir('desc'); }
      }}
    >
      {label} {sortKey === key ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
    </th>
  );

  const colorRate = (r: number) => r >= 0.4 ? 'text-green-600 dark:text-green-400' : r >= 0.2 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400';
  const colorAge = (a: number) => a > 90 ? 'text-red-600 dark:text-red-400' : a > 60 ? 'text-amber-600 dark:text-amber-400' : '';

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
                        {pending.records.length} records · As of {pending.asOfDate} · {new Set(pending.records.map(r => r.channelAccountManager || '(none)')).size} CAMs
                      </p>
                    </div>
                  </div>
                  {pending.errors.length > 0 && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mb-2">{pending.errors.length} parse warning(s)</p>
                  )}
                  <div className="flex gap-2">
                    <Button size="sm" onClick={confirmImport}>Confirm import (replaces previous snapshot)</Button>
                    <Button size="sm" variant="outline" onClick={() => setPending(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <UploadZone
                  onParsed={(records, asOfDate, fileName, errors) => setPending({ records, asOfDate, fileName, errors })}
                />
              )}
              {hasData && (
                <button onClick={() => { setShowUploader(false); setPending(null); }} className="text-xs text-muted-foreground hover:text-foreground">
                  Cancel
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3 p-3 border border-border rounded-md bg-secondary/30">
              <FileSpreadsheet size={16} className="text-muted-foreground" />
              <span className="text-xs font-medium">{dealRegistrations.length} deal registrations</span>
              <span className="text-xs text-muted-foreground">· As of {lastBatch?.asOfDate || '—'}</span>
              <span className="text-xs text-muted-foreground">· Uploaded {lastBatch ? new Date(lastBatch.importedAt).toLocaleString() : '—'}</span>
              <button onClick={() => setShowUploader(true)} className="text-xs text-foreground hover:underline flex items-center gap-1 ml-auto">
                <RefreshCw size={12} /> Replace
              </button>
              <button onClick={() => { if (confirm('Clear all DR data?')) clearDrData(); }} className="text-xs text-muted-foreground hover:text-red-600">
                Clear
              </button>
            </div>
          )}
        </div>
        {hasData && (
          <Button variant="outline" size="sm" onClick={exportReport} className="text-xs gap-1.5">
            <Download size={12} /> Export DR Report
          </Button>
        )}
      </div>

      {!hasData && (
        <p className="text-xs text-muted-foreground text-center">No DR data yet. Upload your Salesforce DR report to begin.</p>
      )}

      {hasData && (
        <>
          {/* Global filters */}
          <div className="flex flex-wrap items-center gap-3 p-3 border border-border rounded-md bg-secondary/20">
            <label className="text-xs">
              <span className="text-muted-foreground mr-1">CAM:</span>
              <select value={camFilter} onChange={e => setCamFilter(e.target.value)} className="text-xs bg-background border border-border rounded px-1.5 py-1">
                <option value="all">All</option>
                {allCams.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="text-xs">
              <span className="text-muted-foreground mr-1">Rep:</span>
              <select value={repFilter} onChange={e => setRepFilter(e.target.value)} className="text-xs bg-background border border-border rounded px-1.5 py-1">
                <option value="all">All</option>
                {allReps.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label className="text-xs">
              <span className="text-muted-foreground mr-1">Quarter (created):</span>
              <select value={quarterFilter} onChange={e => setQuarterFilter(e.target.value)} className="text-xs bg-background border border-border rounded px-1.5 py-1">
                <option value="all">All time</option>
                {allQuarters.map(q => <option key={q} value={q}>{q}</option>)}
              </select>
            </label>
            {filtersActive && (
              <>
                <span className="text-xs text-amber-600 dark:text-amber-400">Filters active</span>
                <button onClick={() => { setCamFilter('all'); setRepFilter('all'); setQuarterFilter('all'); }} className="text-xs text-foreground hover:underline">Clear all</button>
              </>
            )}
            <span className="text-xs text-muted-foreground ml-auto">{filtered.length} DRs in scope</span>
          </div>

          {/* Section B: CAM Funnel */}
          <section className="border border-border rounded-md">
            <div className="px-3 py-2 border-b border-border flex items-center justify-between">
              <h3 className="text-xs font-semibold">CAM Conversion Funnel</h3>
              {expandedCam && (
                <button onClick={() => setExpandedCam(null)} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                  <X size={12} /> Clear CAM filter ({expandedCam})
                </button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-secondary/40 text-muted-foreground">
                  <tr>
                    <th className="text-left px-2 py-1.5 font-medium">CAM</th>
                    <th className="text-right px-2 py-1.5 font-medium">DRs</th>
                    <th className="text-right px-2 py-1.5 font-medium">SQLs</th>
                    <th className="text-right px-2 py-1.5 font-medium">SQL Rate</th>
                    <th className="text-right px-2 py-1.5 font-medium">Stale DRs</th>
                    <th className="text-right px-2 py-1.5 font-medium">Accounts</th>
                    <th className="text-right px-2 py-1.5 font-medium">Padded Accts</th>
                    <th className="text-right px-2 py-1.5 font-medium">Avg Age</th>
                    <th className="text-right px-2 py-1.5 font-medium">Pipeline $</th>
                  </tr>
                </thead>
                <tbody>
                  {camRows.map(r => (
                    <tr
                      key={r.cam}
                      onClick={() => setExpandedCam(expandedCam === r.cam ? null : r.cam)}
                      className={`border-t border-border cursor-pointer hover:bg-muted/40 ${expandedCam === r.cam ? 'bg-muted/60' : ''}`}
                    >
                      <td className="px-2 py-1.5 font-medium">{r.cam}</td>
                      <td className="text-right px-2 py-1.5">{r.count}</td>
                      <td className="text-right px-2 py-1.5">{r.sqls}</td>
                      <td className={`text-right px-2 py-1.5 font-medium ${colorRate(r.sqlRate)}`}>{fmtPct(r.sqlRate, 1)}</td>
                      <td className={`text-right px-2 py-1.5 ${r.stale > 0 ? 'text-red-600 dark:text-red-400 font-medium' : ''}`}>{r.stale}</td>
                      <td className="text-right px-2 py-1.5">{r.accounts}</td>
                      <td className={`text-right px-2 py-1.5 ${r.padded > 0 ? 'text-red-600 dark:text-red-400 font-medium' : ''}`}>{r.padded}</td>
                      <td className={`text-right px-2 py-1.5 ${colorAge(r.avgAge)}`}>{r.avgAge.toFixed(0)}d</td>
                      <td className="text-right px-2 py-1.5">{fmtMoney(r.pipeline)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-border font-medium bg-secondary/30">
                    <td className="px-2 py-1.5">Total</td>
                    <td className="text-right px-2 py-1.5">{camTotals.total}</td>
                    <td className="text-right px-2 py-1.5">{camTotals.sqls}</td>
                    <td className={`text-right px-2 py-1.5 ${colorRate(camTotals.rate)}`}>{fmtPct(camTotals.rate, 1)}</td>
                    <td className="text-right px-2 py-1.5">{camTotals.stale}</td>
                    <td className="text-right px-2 py-1.5">—</td>
                    <td className="text-right px-2 py-1.5">—</td>
                    <td className="text-right px-2 py-1.5">—</td>
                    <td className="text-right px-2 py-1.5">{fmtMoney(camTotals.pipeline)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {insights.length > 0 && (
              <div className="px-3 py-2 border-t border-border bg-secondary/20 space-y-1">
                {insights.map((line, i) => (
                  <p key={i} className="text-xs">{line}</p>
                ))}
              </div>
            )}
          </section>

          {/* Section C: Funnel + Staleness */}
          <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="border border-border rounded-md">
              <div className="px-3 py-2 border-b border-border">
                <h3 className="text-xs font-semibold">Stage Funnel</h3>
              </div>
              <div className="p-3 space-y-1.5">
                {stageRows.map((r, i) => {
                  const isSqlLine = i === 2;
                  return (
                    <div key={r.stage}>
                      {isSqlLine && (
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
                    </div>
                  );
                })}
                <p className="text-xs text-muted-foreground pt-2 border-t border-border mt-2">
                  SQL conversion rate: <span className="font-medium text-foreground">{fmtPct(camTotals.rate, 1)}</span>
                </p>
              </div>
            </div>

            <div className="border border-border rounded-md">
              <div className="px-3 py-2 border-b border-border">
                <h3 className="text-xs font-semibold">Staleness by Stage</h3>
              </div>
              <table className="w-full text-xs">
                <thead className="bg-secondary/40 text-muted-foreground">
                  <tr>
                    <th className="text-left px-2 py-1.5 font-medium">Stage</th>
                    <th className="text-right px-2 py-1.5 font-medium">Total</th>
                    <th className="text-right px-2 py-1.5 font-medium">Stale</th>
                    <th className="text-right px-2 py-1.5 font-medium">Stale %</th>
                    <th className="text-right px-2 py-1.5 font-medium">Avg Age</th>
                  </tr>
                </thead>
                <tbody>
                  {stageRows.map(r => (
                    <tr key={r.stage} className="border-t border-border">
                      <td className="px-2 py-1.5">{r.stage}</td>
                      <td className="text-right px-2 py-1.5">{r.count}</td>
                      <td className="text-right px-2 py-1.5">{r.stale}</td>
                      <td className={`text-right px-2 py-1.5 ${r.stalePct > 0.5 ? 'text-red-600 dark:text-red-400 font-medium' : ''}`}>{fmtPct(r.stalePct)}</td>
                      <td className="text-right px-2 py-1.5">{r.avgStaleAge ? `${r.avgStaleAge.toFixed(0)}d` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-3 py-2 border-t border-border bg-secondary/20">
                <p className="text-xs">
                  <span className="font-medium">{staleTotal.count} stale deals</span>
                  <span className="text-muted-foreground"> · {fmtMoney(staleTotal.value)} in stale pipeline. </span>
                  <span className="text-muted-foreground">Consider requesting CAMs to update or withdraw.</span>
                </p>
              </div>
            </div>
          </section>

          {/* Section D: Detail */}
          <section className="border border-border rounded-md">
            <div className="px-3 py-2 border-b border-border flex flex-wrap items-center gap-3">
              <h3 className="text-xs font-semibold">Deal Detail</h3>
              <label className="text-xs">
                <span className="text-muted-foreground mr-1">Stage:</span>
                <select value={stageFilter} onChange={e => setStageFilter(e.target.value)} className="text-xs bg-background border border-border rounded px-1.5 py-0.5">
                  <option value="all">All</option>
                  {STAGE_ORDER.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="text-xs">
                <span className="text-muted-foreground mr-1">Status:</span>
                <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="text-xs bg-background border border-border rounded px-1.5 py-0.5">
                  <option value="all">All</option>
                  <option value="SQL">SQL</option>
                  <option value="Active">Active</option>
                  <option value="Stale">Stale</option>
                  <option value="Padded">Padded</option>
                </select>
              </label>
              <label className="text-xs flex items-center gap-1">
                <input type="checkbox" checked={staleOnly} onChange={e => setStaleOnly(e.target.checked)} />
                Stale only
              </label>
              <span className="text-xs text-muted-foreground ml-auto">{detailRows.length} shown</span>
            </div>
            <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-secondary/40 text-muted-foreground sticky top-0">
                  <tr>
                    <th className="w-6"></th>
                    {sortHeader('account', 'Account')}
                    {sortHeader('name', 'Opportunity')}
                    {sortHeader('rep', 'Rep')}
                    {sortHeader('cam', 'CAM')}
                    {sortHeader('stage', 'Stage')}
                    {sortHeader('probability', 'Prob')}
                    {sortHeader('amount', 'Amount')}
                    {sortHeader('ageDays', 'Age')}
                    {sortHeader('lastActivity', 'Last Activity')}
                    {sortHeader('reseller', 'Reseller')}
                    <th className="text-left px-2 py-1.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {detailRows.map(r => {
                    const isOpen = expandedRow === r.d.opportunityId;
                    return (
                      <FragmentWithKey key={r.d.opportunityId}>
                        <tr
                          key={r.d.opportunityId}
                          onClick={() => setExpandedRow(isOpen ? null : r.d.opportunityId)}
                          className="border-t border-border cursor-pointer hover:bg-muted/40"
                        >
                          <td className="px-1 py-1.5">{isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</td>
                          <td className="px-2 py-1.5">{r.d.accountName || '—'}</td>
                          <td className="px-2 py-1.5">{r.d.opportunityName}</td>
                          <td className="px-2 py-1.5">{r.d.repName}</td>
                          <td className="px-2 py-1.5">{r.d.channelAccountManager || '—'}</td>
                          <td className="px-2 py-1.5">{r.d.stage}</td>
                          <td className="text-right px-2 py-1.5">{fmtPct(r.d.probability)}</td>
                          <td className="text-right px-2 py-1.5">{r.d.amount ? fmtMoney(r.d.amount) : '—'}</td>
                          <td className={`text-right px-2 py-1.5 ${colorAge(r.d.ageDays)}`}>{r.d.ageDays}d</td>
                          <td className="px-2 py-1.5">{r.d.lastActivity || '—'}</td>
                          <td className="px-2 py-1.5">{r.d.resellerName || '—'}</td>
                          <td className="px-2 py-1.5">
                            <div className="flex gap-1 flex-wrap">
                              {r.status.map(s => {
                                const cls = s === 'SQL' ? 'bg-green-500/15 text-green-700 dark:text-green-400'
                                  : s === 'Active' ? 'bg-blue-500/15 text-blue-700 dark:text-blue-400'
                                  : s === 'Stale' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                                  : 'bg-red-500/15 text-red-700 dark:text-red-400';
                                return <span key={s} className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${cls}`}>{s}</span>;
                              })}
                            </div>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-muted/20 border-t border-border">
                            <td></td>
                            <td colSpan={11} className="px-3 py-3">
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                                <div><span className="text-muted-foreground">Opportunity ID:</span> {r.d.opportunityId}</div>
                                <div><span className="text-muted-foreground">Created:</span> {r.d.createdDate || '—'}</div>
                                <div><span className="text-muted-foreground">Close Date:</span> {r.d.closeDate || '—'}</div>
                                <div><span className="text-muted-foreground">Expected Revenue:</span> {r.d.expectedRevenue ? fmtMoney(r.d.expectedRevenue) : '—'}</div>
                                <div><span className="text-muted-foreground">2nd Owner:</span> {r.d.secondOwner || '—'}</div>
                                <div><span className="text-muted-foreground">Distributor:</span> {r.d.distributorReseller || '—'}</div>
                                <div><span className="text-muted-foreground">Product:</span> {r.d.product || '—'}</div>
                                <div><span className="text-muted-foreground">Type:</span> {r.d.type || '—'}</div>
                                <div><span className="text-muted-foreground">Billing State:</span> {r.d.billingState || '—'}</div>
                                <div><span className="text-muted-foreground">Lead Source:</span> {r.d.leadSource || '—'}</div>
                                <div><span className="text-muted-foreground">Registered Deal:</span> {r.d.registeredDeal ? 'Yes' : 'No'}</div>
                              </div>
                              {r.matchOpp && (
                                <div className="mt-3 pt-3 border-t border-border">
                                  <span className="inline-block px-1.5 py-0.5 bg-green-500/15 text-green-700 dark:text-green-400 rounded text-[10px] font-medium mr-2">In Pipeline ✓</span>
                                  <span className="text-xs text-muted-foreground">
                                    Stage: <span className="text-foreground">{r.matchOpp.stage}</span>
                                    {' · '}Amount: <span className="text-foreground">{fmtMoney(r.matchOpp.amount)}</span>
                                  </span>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </FragmentWithKey>
                    );
                  })}
                </tbody>
              </table>
              {detailRows.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">No deals match filters.</p>}
            </div>
          </section>

          {/* Section E: Account Padding */}
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
                    <th className="text-left px-2 py-1.5 font-medium">CAM(s)</th>
                    <th className="text-right px-2 py-1.5 font-medium">Total DRs</th>
                    <th className="text-right px-2 py-1.5 font-medium">Pre-SQL DRs</th>
                    <th className="text-right px-2 py-1.5 font-medium">SQL DRs</th>
                    <th className="text-left px-2 py-1.5 font-medium">Padded?</th>
                    <th className="text-left px-2 py-1.5 font-medium">Products</th>
                  </tr>
                </thead>
                <tbody>
                  {accountRows.map(a => {
                    const multiCam = a.cams.length > 1;
                    const paddedColor = a.padded === 'yes' ? 'bg-red-500/15 text-red-700 dark:text-red-400'
                      : a.padded === 'maybe' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                      : 'bg-green-500/15 text-green-700 dark:text-green-400';
                    return (
                      <tr key={a.account} className="border-t border-border">
                        <td className="px-2 py-1.5 font-medium">{a.account}</td>
                        <td className={`px-2 py-1.5 ${multiCam ? 'text-amber-600 dark:text-amber-400 font-medium' : ''}`}>{a.cams.join(', ')}</td>
                        <td className="text-right px-2 py-1.5">{a.total}</td>
                        <td className="text-right px-2 py-1.5">{a.preSql}</td>
                        <td className="text-right px-2 py-1.5">{a.sql}</td>
                        <td className="px-2 py-1.5">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${paddedColor}`}>
                            {a.padded === 'yes' ? 'Yes' : a.padded === 'maybe' ? 'Maybe' : 'No'}
                          </span>
                        </td>
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
