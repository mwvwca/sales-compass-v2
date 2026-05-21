import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ChangeLogEntry, Opportunity, Quarter } from '@/types/forecast';
import { getCurrentQuarter, getQuarter } from '@/types/forecast';

interface Row {
  repName: string;
  quarter: Quarter;
  committedCount: number;
  committedAmount: number;
  closedFromCommitCount: number;
  closedFromCommitAmount: number;
  inProgress: boolean;
}

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function tone(amountAcc: number, inProgress: boolean): string {
  if (inProgress) return 'text-muted-foreground italic';
  if (amountAcc >= 0.8) return 'text-positive';
  if (amountAcc >= 0.5) return 'text-upside';
  return 'text-negative';
}

export default function CommitAccuracySection({
  opportunities,
  changelog,
}: {
  opportunities: Opportunity[];
  changelog: ChangeLogEntry[];
}) {
  const [open, setOpen] = useState(false);
  const currentQ = getCurrentQuarter();

  const { rows, quarters, reps } = useMemo(() => {
    // For each opp, find quarters in which it was committed.
    // committedInQuarter: q -> Set<oppId>
    const repCommittedByQ = new Map<string, Map<Quarter, Set<string>>>();
    const repClosedByQ = new Map<string, Map<Quarter, Set<string>>>();
    const allQuarters = new Set<Quarter>();
    const allReps = new Set<string>();

    const ensure = (m: Map<string, Map<Quarter, Set<string>>>, rep: string, q: Quarter) => {
      let inner = m.get(rep);
      if (!inner) { inner = new Map(); m.set(rep, inner); }
      let s = inner.get(q);
      if (!s) { s = new Set(); inner.set(q, s); }
      return s;
    };

    const oppById = new Map(opportunities.map(o => [o.id, o]));

    // From changelog: any classification -> commit entry
    for (const e of changelog) {
      if (e.field === 'classification' && e.newValue === 'commit' && e.importDate) {
        const q = getQuarter(e.importDate);
        const opp = oppById.get(e.opportunityId);
        const repName = opp?.repName || e.repName;
        if (!repName) continue;
        ensure(repCommittedByQ, repName, q).add(e.opportunityId);
        allQuarters.add(q);
        allReps.add(repName);
      }
    }

    // Opps currently classified 'commit' whose importDate falls in some quarter (first-import case)
    for (const o of opportunities) {
      if (o.classification === 'commit' && o.importDate) {
        const q = getQuarter(o.importDate);
        ensure(repCommittedByQ, o.repName, q).add(o.id);
        allQuarters.add(q);
        allReps.add(o.repName);
      }
    }

    // Closed from commit: opp currently closed_won AND was ever committed in a quarter AND closeDate in that quarter
    for (const o of opportunities) {
      if (o.classification !== 'closed_won' || !o.closeDate) continue;
      const closeQ = getQuarter(o.closeDate);
      const committedQs = repCommittedByQ.get(o.repName);
      if (committedQs?.get(closeQ)?.has(o.id)) {
        ensure(repClosedByQ, o.repName, closeQ).add(o.id);
      }
    }

    const quartersArr = Array.from(allQuarters).sort();
    const repsArr = Array.from(allReps).sort();

    const rows: Row[] = [];
    for (const rep of repsArr) {
      for (const q of quartersArr) {
        const committed = repCommittedByQ.get(rep)?.get(q);
        if (!committed || committed.size === 0) continue;
        const closed = repClosedByQ.get(rep)?.get(q) || new Set();
        const committedAmount = Array.from(committed).reduce((s, id) => s + (oppById.get(id)?.amount || 0), 0);
        const closedAmount = Array.from(closed).reduce((s, id) => s + (oppById.get(id)?.amount || 0), 0);
        rows.push({
          repName: rep, quarter: q,
          committedCount: committed.size,
          committedAmount,
          closedFromCommitCount: closed.size,
          closedFromCommitAmount: closedAmount,
          inProgress: q === currentQ,
        });
      }
    }

    return { rows, quarters: quartersArr, reps: repsArr };
  }, [opportunities, changelog, currentQ]);

  const byRepQ = useMemo(() => {
    const m = new Map<string, Map<Quarter, Row>>();
    for (const r of rows) {
      if (!m.has(r.repName)) m.set(r.repName, new Map());
      m.get(r.repName)!.set(r.quarter, r);
    }
    return m;
  }, [rows]);

  // Insight
  const insight = useMemo(() => {
    if (reps.length === 0 || quarters.length === 0) return null;
    const completedQs = quarters.filter(q => q !== currentQ);
    const lowReps: { rep: string; consecutive: number; deals: number; pctRate: number }[] = [];
    let allHealthy = true;
    for (const rep of reps) {
      let consecutive = 0, maxConsec = 0, dealsInRun = 0, totalCommitted = 0, totalClosed = 0;
      for (const q of completedQs) {
        const r = byRepQ.get(rep)?.get(q);
        if (!r) { consecutive = 0; continue; }
        totalCommitted += r.committedAmount;
        totalClosed += r.closedFromCommitAmount;
        const acc = r.committedAmount > 0 ? r.closedFromCommitAmount / r.committedAmount : 1;
        if (acc < 0.5) { consecutive++; dealsInRun += r.committedCount; maxConsec = Math.max(maxConsec, consecutive); }
        else consecutive = 0;
        if (acc < 0.7) allHealthy = false;
      }
      if (maxConsec >= 2) {
        const pctRate = totalCommitted > 0 ? Math.round((totalClosed / totalCommitted) * 100) : 0;
        lowReps.push({ rep, consecutive: maxConsec, deals: dealsInRun, pctRate });
      }
    }
    if (lowReps.length > 0) {
      const r = lowReps[0];
      return `⚠ ${r.rep} has committed ${r.deals} deals across the last ${r.consecutive} quarters with ${r.pctRate}% close rate — consider adjusting commit weighting.`;
    }
    if (allHealthy && completedQs.length > 0) return '✓ Commit accuracy is healthy across the team.';
    return null;
  }, [reps, quarters, byRepQ, currentQ]);

  const enoughData = changelog.length > 0 && rows.length > 0;

  return (
    <div className="border border-border rounded-lg">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-secondary/30 transition-colors"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <div>
          <div className="text-sm font-semibold">Commit accuracy</div>
          <div className="text-xs text-muted-foreground">Historical rate at which each rep's committed deals closed, by quarter.</div>
        </div>
      </button>
      {open && (
        <div className="px-4 pb-4">
          {!enoughData ? (
            <p className="text-xs text-muted-foreground py-4">Not enough data yet — these insights will populate as you import more data.</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-secondary/50">
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground uppercase tracking-wider">Rep</th>
                      {quarters.map(q => (
                        <th key={q} className="text-right px-3 py-2 font-mono font-medium text-muted-foreground uppercase tracking-wider">{q}</th>
                      ))}
                      <th className="text-right px-3 py-2 font-mono font-medium text-muted-foreground uppercase tracking-wider">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reps.map(rep => {
                      let tCommittedAmt = 0, tClosedAmt = 0, tCommittedCt = 0, tClosedCt = 0;
                      return (
                        <tr key={rep} className="border-b border-border last:border-0">
                          <td className="px-3 py-2 font-medium">{rep}</td>
                          {quarters.map(q => {
                            const r = byRepQ.get(rep)?.get(q);
                            if (!r) return <td key={q} className="text-right px-3 py-2 font-mono text-muted-foreground">—</td>;
                            const acc = r.committedAmount > 0 ? r.closedFromCommitAmount / r.committedAmount : 0;
                            if (!r.inProgress) {
                              tCommittedAmt += r.committedAmount; tClosedAmt += r.closedFromCommitAmount;
                              tCommittedCt += r.committedCount; tClosedCt += r.closedFromCommitCount;
                            }
                            return (
                              <td key={q} className={`text-right px-3 py-2 font-mono ${tone(acc, r.inProgress)}`}>
                                <div>{r.closedFromCommitCount}/{r.committedCount}</div>
                                <div className="text-[10px]">{r.inProgress ? '—' : `${Math.round(acc * 100)}%`}</div>
                              </td>
                            );
                          })}
                          {(() => {
                            const acc = tCommittedAmt > 0 ? tClosedAmt / tCommittedAmt : 0;
                            return (
                              <td className={`text-right px-3 py-2 font-mono ${tCommittedCt > 0 ? tone(acc, false) : 'text-muted-foreground'}`}>
                                <div>{tClosedCt}/{tCommittedCt}</div>
                                <div className="text-[10px]">{tCommittedCt > 0 ? `${Math.round(acc * 100)}%` : '—'}</div>
                              </td>
                            );
                          })()}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {insight && <p className="text-xs text-muted-foreground mt-3">{insight}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
