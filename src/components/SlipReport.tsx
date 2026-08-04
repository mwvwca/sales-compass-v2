import { openOpportunity } from '@/lib/openOpportunity';
import { Fragment, useMemo, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { getQuarter, getCurrentQuarter, type Quarter } from '@/types/forecast';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, ChevronRight, Download } from 'lucide-react';
import { computeSlips, type SuggestedAction } from '@/lib/slips';
import * as XLSX from '@e965/xlsx';

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const ymd = (s: string) => (s || '').slice(0, 10) || '—';

const actionTone: Record<SuggestedAction, string> = {
  'Confirm new date': 'bg-primary/15 text-primary border-transparent',
  'Reforecast': 'bg-upside/20 text-upside border-transparent',
  'Review for disqualification': 'bg-destructive/20 text-destructive border-transparent',
};

export default function SlipReport() {
  const { opportunities, changelog, snapshots } = useForecast();
  const currentQ = getCurrentQuarter();

  // Available prior quarters from changelog (exclude current)
  const availableQuarters = useMemo(() => {
    const qs = new Set<Quarter>();
    for (const e of changelog) {
      if (e.field === 'classification' || e.field === 'closeDate') {
        if (e.importDate) qs.add(getQuarter(e.importDate));
        if (e.field === 'closeDate' && e.oldValue) {
          try { qs.add(getQuarter(e.oldValue)); } catch {}
        }
      }
    }
    qs.delete(currentQ);
    return Array.from(qs).sort();
  }, [changelog, currentQ]);

  const [selectedQuarter, setSelectedQuarter] = useState<Quarter | ''>('');
  const effectiveQuarter = selectedQuarter || (availableQuarters[availableQuarters.length - 1] ?? '');

  const repNames = useMemo(() => Array.from(new Set(opportunities.map(o => o.repName))).sort(), [opportunities]);
  const [repFilter, setRepFilter] = useState<string | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'date_pushed' | 'classification_dropped'>('all');
  const [openOnly, setOpenOnly] = useState(true);               // default: actionable open deals only
  const [sortMode, setSortMode] = useState<'dollars_out' | 'slip_count'>('dollars_out');
  const [expanded, setExpanded] = useState<string | null>(null);

  const allSlips = useMemo(() => {
    if (!effectiveQuarter) return [];
    return computeSlips(opportunities, changelog, snapshots, effectiveQuarter as Quarter);
  }, [opportunities, changelog, snapshots, effectiveQuarter]);

  // Filtered + sorted — this exact list is what the table shows AND what Export emits.
  const slips = useMemo(() => {
    const filtered = allSlips.filter(s => {
      if (openOnly && !s.isOpen) return false;                  // stage-strict resolved check
      if (repFilter !== 'all' && s.repName !== repFilter) return false;
      if (typeFilter !== 'all' && !s.slipReasons.includes(typeFilter)) return false;
      return true;
    });
    return filtered.sort((a, b) => {
      if (sortMode === 'slip_count') {
        return b.outwardMoveCount - a.outwardMoveCount || b.amount - a.amount;
      }
      // dollars that slipped OUT of the current period, descending
      const av = a.crossesToLaterPeriod ? a.amount : 0;
      const bv = b.crossesToLaterPeriod ? b.amount : 0;
      return bv - av || b.amount - a.amount;
    });
  }, [allSlips, openOnly, repFilter, typeFilter, sortMode]);

  const enoughData = changelog.length > 0 && availableQuarters.length > 0;

  const exportRows = () => {
    const rows = slips.map(s => ({
      'Opportunity ID': s.opportunityId,
      'Opportunity': s.opportunityName,
      'Owner': s.repName,
      'Reseller': s.resolvedReseller || '',
      'Product': s.productName || '',
      'Amount': s.amount,
      'Original Close': ymd(s.originalCloseDate),
      'Current Close': ymd(s.currentCloseDate),
      'Total Slip (days)': s.totalSlipDays,
      'Outward Moves': s.outwardMoveCount,
      'Crosses Period': s.crossesToLaterPeriod ? 'Yes' : 'No',
      'Days Since Activity': s.daysSinceActivity ?? '',
      'Suggested Action': s.suggestedAction,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Slips');
    const date = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `slips-${effectiveQuarter || 'all'}-${date}.xlsx`);
  };

  if (!enoughData) {
    return (
      <div className="border border-border rounded-lg p-6">
        <p className="text-xs text-muted-foreground">Not enough data yet — these insights will populate as you import more data.</p>
      </div>
    );
  }

  // Summary (over the filtered set on screen)
  const totalCount = slips.length;
  const totalValue = slips.reduce((s, r) => s + r.amount, 0);
  const outOfPeriodCt = slips.filter(s => s.crossesToLaterPeriod).length;
  const outOfPeriodAmt = slips.filter(s => s.crossesToLaterPeriod).reduce((s, r) => s + r.amount, 0);
  const disqualCt = slips.filter(s => s.suggestedAction === 'Review for disqualification').length;

  // Per-rep summary using all slips for selected quarter (not type/open-filtered)
  const repSummary = useMemo(() => {
    const repsInQ = new Set(allSlips.map(s => s.repName));
    return Array.from(repsInQ).map(rep => {
      const repSlips = allSlips.filter(s => s.repName === rep);
      const slipCt = repSlips.length;
      const slipAmt = repSlips.reduce((s, r) => s + r.amount, 0);
      const openCt = repSlips.filter(s => s.isOpen).length;
      const recCt = repSlips.filter(s => s.isNowClosed).length;
      const closedWonCt = opportunities.filter(o =>
        o.repName === rep &&
        o.classification === 'closed_won' &&
        o.closeDate && getQuarter(o.closeDate) === effectiveQuarter
      ).length;
      const denom = slipCt + closedWonCt;
      const slipRate = denom > 0 ? slipCt / denom : 0;
      return { rep, slipCt, slipAmt, openCt, recCt, slipRate };
    }).sort((a, b) => b.slipAmt - a.slipAmt);
  }, [allSlips, opportunities, effectiveQuarter]);

  const slipRateTone = (r: number) => r < 0.2 ? 'text-positive' : r <= 0.4 ? 'text-upside' : 'text-negative';

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <select value={effectiveQuarter} onChange={e => setSelectedQuarter(e.target.value as Quarter)}
          className="bg-secondary border border-border rounded-md px-3 py-1.5 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-ring">
          {availableQuarters.map(q => <option key={q} value={q}>{q}</option>)}
        </select>
        <select value={repFilter} onChange={e => setRepFilter(e.target.value)}
          className="bg-secondary border border-border rounded-md px-3 py-1.5 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-ring">
          <option value="all">All Reps</option>
          {repNames.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <div className="flex gap-0.5 bg-secondary rounded-md p-0.5">
          {([
            ['all', 'All'],
            ['date_pushed', 'Close date pushed'],
            ['classification_dropped', 'Classification dropped'],
          ] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTypeFilter(k)}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${typeFilter === k ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}>
              {l}
            </button>
          ))}
        </div>
        {/* Sort toggle */}
        <div className="flex gap-0.5 bg-secondary rounded-md p-0.5">
          {([
            ['dollars_out', '$ slipped out'],
            ['slip_count', 'Repeat slippers'],
          ] as const).map(([k, l]) => (
            <button key={k} onClick={() => setSortMode(k)}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${sortMode === k ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}>
              {l}
            </button>
          ))}
        </div>
        {/* Open-only toggle */}
        <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={openOnly} onChange={e => setOpenOnly(e.target.checked)} className="accent-foreground" />
          Open deals only
        </label>
        <button onClick={exportRows}
          className="ml-auto flex items-center gap-1.5 bg-secondary border border-border rounded-md px-3 py-1.5 text-xs font-medium hover:bg-secondary/70 transition-colors">
          <Download size={13} /> Export
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Slipped Deals</p>
          <p className="text-xl font-mono font-semibold">{totalCount}</p>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Slipped Value</p>
          <p className="text-xl font-mono font-semibold">{fmt(totalValue)}</p>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Out of Period</p>
          <p className="text-xl font-mono font-semibold">{outOfPeriodCt}</p>
          <p className="text-xs font-mono mt-0.5 text-muted-foreground">{fmt(outOfPeriodAmt)}</p>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Review for Disqual</p>
          <p className="text-xl font-mono font-semibold text-destructive">{disqualCt}</p>
        </div>
      </div>

      {/* Slip table */}
      <div className="border border-border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/50">
              <th className="w-8"></th>
              {['Opportunity', 'Owner', 'Reseller', 'Product'].map(h => (
                <th key={h} className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">{h}</th>
              ))}
              <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Amount</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Orig Close</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Curr Close</th>
              <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Slip (d)</th>
              <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Moves</th>
              <th className="text-center px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Crosses</th>
              <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Last Activity</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Suggested Action</th>
            </tr>
          </thead>
          <tbody>
            {slips.length === 0 && (
              <tr><td colSpan={13} className="text-center px-3 py-6 text-xs text-muted-foreground">No slips match the current filters.</td></tr>
            )}
            {slips.map(s => {
              const isOpenRow = expanded === s.opportunityId;
              return (
                <Fragment key={s.opportunityId}>
                  <tr
                    onClick={() => setExpanded(isOpenRow ? null : s.opportunityId)}
                    className="border-b border-border last:border-0 hover:bg-secondary/30 transition-colors cursor-pointer">
                    <td className="px-2 py-2">{isOpenRow ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</td>
                    <td className="px-3 py-2 text-xs">
                      <button
                        onClick={(e) => { e.stopPropagation(); openOpportunity(s.opportunityId); }}
                        className="text-left hover:underline"
                        title="Open Deal 360"
                      >{s.opportunityName}</button>
                    </td>
                    <td className="px-3 py-2 text-xs">{s.repName}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{s.resolvedReseller || '—'}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{s.productName || '—'}</td>
                    <td className="text-right px-3 py-2 font-mono text-xs">{fmt(s.amount)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{ymd(s.originalCloseDate)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{ymd(s.currentCloseDate)}</td>
                    <td className="text-right px-3 py-2 font-mono text-xs">{s.totalSlipDays}</td>
                    <td className="text-right px-3 py-2 font-mono text-xs">{s.outwardMoveCount}</td>
                    <td className="text-center px-3 py-2 text-xs">{s.crossesToLaterPeriod ? <span className="text-negative">✓</span> : <span className="text-muted-foreground">—</span>}</td>
                    <td className="text-right px-3 py-2 font-mono text-xs">{s.daysSinceActivity == null ? '—' : `${s.daysSinceActivity}d`}</td>
                    <td className="px-3 py-2">
                      <Badge className={actionTone[s.suggestedAction]}>{s.suggestedAction}</Badge>
                    </td>
                  </tr>
                  {isOpenRow && (
                    <tr key={s.opportunityId + '-detail'} className="bg-secondary/20 border-b border-border">
                      <td></td>
                      <td colSpan={12} className="px-3 py-3">
                        <div className="text-[11px] space-y-2">
                          <div className="flex gap-4 text-muted-foreground">
                            <span>Stage: <span className="text-foreground">{s.currentStage}</span></span>
                            <span>Class: <span className="text-foreground">{s.currentClassification}</span></span>
                            <span>Was due: <span className="text-foreground">{s.originalQuarter}</span> → <span className="text-foreground">{s.currentQuarter}</span></span>
                            {s.channelAccountManager && <span>CAM: <span className="text-foreground">{s.channelAccountManager}</span></span>}
                          </div>
                          <div className="font-medium text-muted-foreground uppercase tracking-wider">Timeline</div>
                          {[...s.closeDateHistory.map(h => ({ ...h, kind: 'date' as const })),
                            ...s.classificationHistory.map(h => ({ ...h, kind: 'class' as const }))]
                            .sort((a, b) => a.date.localeCompare(b.date))
                            .map((h, i) => (
                              <div key={i} className="flex gap-3 font-mono">
                                <span className="text-muted-foreground">{h.date.slice(0, 10)}</span>
                                <span>{h.kind === 'date' ? 'Close date' : 'Classification'}:</span>
                                <span className="text-muted-foreground">{h.from || '—'}</span>
                                <span>→</span>
                                <span>{h.to || '—'}</span>
                              </div>
                            ))}
                          {s.closeDateHistory.length === 0 && s.classificationHistory.length === 0 && (
                            <div className="text-muted-foreground">No history.</div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Rep summary */}
      {repSummary.length > 0 && (
        <div className="border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Rep</th>
                <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Slipped Deals</th>
                <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Slipped $</th>
                <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Still Open</th>
                <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Recovered</th>
                <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Slip Rate</th>
              </tr>
            </thead>
            <tbody>
              {repSummary.map(r => (
                <tr key={r.rep} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 text-xs font-medium">{r.rep}</td>
                  <td className="text-right px-3 py-2 font-mono text-xs">{r.slipCt}</td>
                  <td className="text-right px-3 py-2 font-mono text-xs">{fmt(r.slipAmt)}</td>
                  <td className="text-right px-3 py-2 font-mono text-xs">{r.openCt}</td>
                  <td className="text-right px-3 py-2 font-mono text-xs text-positive">{r.recCt}</td>
                  <td className={`text-right px-3 py-2 font-mono text-xs ${slipRateTone(r.slipRate)}`}>
                    {Math.round(r.slipRate * 100)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
