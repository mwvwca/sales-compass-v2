import { Fragment, useMemo, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { getQuarter, getCurrentQuarter, type Quarter, type ChangeLogEntry, type Opportunity } from '@/types/forecast';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, ChevronRight } from 'lucide-react';

type SlipReason = 'date_pushed' | 'classification_dropped';

interface SlipRecord {
  opportunityId: string;
  opportunityName: string;
  repName: string;
  channelAccountManager?: string;
  accountName?: string;
  amount: number;
  originalCloseDate: string;
  originalQuarter: Quarter;
  currentCloseDate: string;
  currentQuarter: Quarter;
  currentClassification: string;
  currentStage: string;
  slipReasons: SlipReason[];
  classDropFrom?: 'commit' | 'upside';
  quartersPushed: number;
  classificationHistory: { from: string; to: string; date: string }[];
  closeDateHistory: { from: string; to: string; date: string }[];
  isNowClosed: boolean;
  isNowLost: boolean;
  isStillOpen: boolean;
}

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function quarterIndex(q: Quarter): number {
  const [y, qq] = q.split('-Q').map(Number);
  return y * 4 + (qq - 1);
}

function computeSlips(
  opps: Opportunity[],
  changelog: ChangeLogEntry[],
  selectedQuarter: Quarter,
): SlipRecord[] {
  const oppById = new Map(opps.map(o => [o.id, o]));
  const byOpp = new Map<string, ChangeLogEntry[]>();
  for (const e of changelog) {
    if (!byOpp.has(e.opportunityId)) byOpp.set(e.opportunityId, []);
    byOpp.get(e.opportunityId)!.push(e);
  }
  for (const arr of byOpp.values()) arr.sort((a, b) => a.importDate.localeCompare(b.importDate));

  const records: SlipRecord[] = [];
  for (const opp of opps) {
    const entries = byOpp.get(opp.id) || [];
    const dateChanges = entries.filter(e => e.field === 'closeDate' && e.oldValue && e.newValue);
    const classChanges = entries.filter(e => e.field === 'classification');

    // Condition A: original quarter (oldValue) == selectedQuarter AND newValue quarter > selectedQuarter
    let datePushHit: ChangeLogEntry | null = null;
    for (const e of dateChanges) {
      try {
        const oldQ = getQuarter(e.oldValue);
        const newQ = getQuarter(e.newValue);
        if (oldQ === selectedQuarter && quarterIndex(newQ) > quarterIndex(oldQ)) {
          datePushHit = e;
          break;
        }
      } catch { /* skip */ }
    }

    // Condition B: classification drop in selectedQuarter
    const drop = new Set(['unclassified', 'lost', 'omitted', 'rejected']);
    const from = new Set(['commit', 'upside']);
    let classDropHit: ChangeLogEntry | null = null;
    for (const e of classChanges) {
      if (from.has(e.oldValue) && drop.has(e.newValue) && getQuarter(e.importDate) === selectedQuarter) {
        classDropHit = e;
        break;
      }
    }

    if (!datePushHit && !classDropHit) continue;

    const reasons: SlipReason[] = [];
    if (datePushHit) reasons.push('date_pushed');
    if (classDropHit) reasons.push('classification_dropped');

    const originalCloseDate = datePushHit?.oldValue || opp.closeDate;
    const originalQuarter: Quarter = datePushHit ? getQuarter(datePushHit.oldValue) : selectedQuarter;
    const currentCloseDate = opp.closeDate;
    const currentQuarter: Quarter = opp.closeDate ? getQuarter(opp.closeDate) : selectedQuarter;
    const quartersPushed = datePushHit
      ? Math.max(0, quarterIndex(currentQuarter) - quarterIndex(originalQuarter))
      : 0;

    records.push({
      opportunityId: opp.id,
      opportunityName: opp.name,
      repName: opp.repName,
      channelAccountManager: opp.channelAccountManager,
      accountName: opp.accountName,
      amount: opp.amount,
      originalCloseDate,
      originalQuarter,
      currentCloseDate,
      currentQuarter,
      currentClassification: opp.classification,
      currentStage: opp.stage,
      slipReasons: reasons,
      classDropFrom: classDropHit ? (classDropHit.oldValue as 'commit' | 'upside') : undefined,
      quartersPushed,
      classificationHistory: classChanges.map(e => ({ from: e.oldValue, to: e.newValue, date: e.importDate })),
      closeDateHistory: dateChanges.map(e => ({ from: e.oldValue, to: e.newValue, date: e.importDate })),
      isNowClosed: opp.classification === 'closed_won',
      isNowLost: opp.classification === 'lost',
      isStillOpen: !['closed_won', 'lost', 'omitted'].includes(opp.classification),
    });
  }
  return records;
}

export default function SlipReport() {
  const { opportunities, changelog } = useForecast();
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
  const [expanded, setExpanded] = useState<string | null>(null);

  const allSlips = useMemo(() => {
    if (!effectiveQuarter) return [];
    return computeSlips(opportunities, changelog, effectiveQuarter as Quarter);
  }, [opportunities, changelog, effectiveQuarter]);

  const slips = useMemo(() => {
    return allSlips.filter(s => {
      if (repFilter !== 'all' && s.repName !== repFilter) return false;
      if (typeFilter !== 'all' && !s.slipReasons.includes(typeFilter)) return false;
      return true;
    }).sort((a, b) => b.amount - a.amount);
  }, [allSlips, repFilter, typeFilter]);

  const enoughData = changelog.length > 0 && availableQuarters.length > 0;
  if (!enoughData) {
    return (
      <div className="border border-border rounded-lg p-6">
        <p className="text-xs text-muted-foreground">Not enough data yet — these insights will populate as you import more data.</p>
      </div>
    );
  }

  // Summary
  const totalCount = slips.length;
  const totalValue = slips.reduce((s, r) => s + r.amount, 0);
  const stillOpenCt = slips.filter(s => s.isStillOpen).length;
  const stillOpenAmt = slips.filter(s => s.isStillOpen).reduce((s, r) => s + r.amount, 0);
  const recoveredCt = slips.filter(s => s.isNowClosed).length;
  const recoveredAmt = slips.filter(s => s.isNowClosed).reduce((s, r) => s + r.amount, 0);

  // Per-rep summary using all slips for selected quarter (not type-filtered)
  const repSummary = useMemo(() => {
    const repsInQ = new Set(allSlips.map(s => s.repName));
    return Array.from(repsInQ).map(rep => {
      const repSlips = allSlips.filter(s => s.repName === rep);
      const slipCt = repSlips.length;
      const slipAmt = repSlips.reduce((s, r) => s + r.amount, 0);
      const openCt = repSlips.filter(s => s.isStillOpen).length;
      const recCt = repSlips.filter(s => s.isNowClosed).length;
      // Closed won deals in that quarter for this rep
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

  const insightLine = (() => {
    if (allSlips.length === 0) return null;
    return `${allSlips.length} deals worth ${fmt(allSlips.reduce((s, r) => s + r.amount, 0))} slipped from ${effectiveQuarter}. ${fmt(allSlips.filter(s => s.isStillOpen).reduce((s, r) => s + r.amount, 0))} (${allSlips.filter(s => s.isStillOpen).length} deals) are still in pipeline this quarter.`;
  })();

  const highRep = repSummary.find(r => r.slipRate > 0.4);

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
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Still in Pipeline</p>
          <p className="text-xl font-mono font-semibold">{stillOpenCt}</p>
          <p className="text-xs font-mono mt-0.5 text-muted-foreground">{fmt(stillOpenAmt)}</p>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Recovered</p>
          <p className="text-xl font-mono font-semibold text-positive">{recoveredCt}</p>
          <p className="text-xs font-mono mt-0.5 text-positive">{fmt(recoveredAmt)}</p>
        </div>
      </div>

      {/* Slip table */}
      <div className="border border-border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/50">
              <th className="w-8"></th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Opportunity</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Rep</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">CAM</th>
              <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Amount</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Was Due</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Now Due</th>
              <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Qtrs Pushed</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Reason</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Current Status</th>
            </tr>
          </thead>
          <tbody>
            {slips.length === 0 && (
              <tr><td colSpan={10} className="text-center px-3 py-6 text-xs text-muted-foreground">No slips match the current filters.</td></tr>
            )}
            {slips.map(s => {
              const isOpen = expanded === s.opportunityId;
              return (
                <Fragment key={s.opportunityId}>
                  <tr
                    onClick={() => setExpanded(isOpen ? null : s.opportunityId)}
                    className="border-b border-border last:border-0 hover:bg-secondary/30 transition-colors cursor-pointer">

                    <td className="px-2 py-2">{isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</td>
                    <td className="px-3 py-2 text-xs">{s.opportunityName}</td>
                    <td className="px-3 py-2 text-xs">{s.repName}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{s.channelAccountManager || '—'}</td>
                    <td className="text-right px-3 py-2 font-mono text-xs">{fmt(s.amount)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{s.originalQuarter}</td>
                    <td className="px-3 py-2 font-mono text-xs">{s.currentQuarter}</td>
                    <td className="text-right px-3 py-2 font-mono text-xs">{s.quartersPushed}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {s.slipReasons.includes('date_pushed') && (
                          <Badge className="bg-upside/20 text-upside hover:bg-upside/30 border-transparent">Date pushed</Badge>
                        )}
                        {s.slipReasons.includes('classification_dropped') && s.classDropFrom === 'commit' && (
                          <Badge className="bg-destructive/20 text-destructive hover:bg-destructive/30 border-transparent">Dropped from commit</Badge>
                        )}
                        {s.slipReasons.includes('classification_dropped') && s.classDropFrom === 'upside' && (
                          <Badge className="bg-orange-500/20 text-orange-500 hover:bg-orange-500/30 border-transparent">Dropped from upside</Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {s.isNowClosed && <span className="text-positive">Closed Won ✓</span>}
                      {s.isNowLost && <span className="text-negative">Lost ✗</span>}
                      {s.isStillOpen && <span className="text-primary">Still open</span>}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr key={s.opportunityId + '-detail'} className="bg-secondary/20 border-b border-border">
                      <td></td>
                      <td colSpan={9} className="px-3 py-3">
                        <div className="text-[11px] space-y-2">
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

      {insightLine && (
        <p className="text-xs text-muted-foreground">
          {insightLine}
          {highRep && (
            <span className="block mt-1">⚠ {highRep.rep} has a {Math.round(highRep.slipRate * 100)}% slip rate — review commit discipline in 1:1s.</span>
          )}
        </p>
      )}
    </div>
  );
}
