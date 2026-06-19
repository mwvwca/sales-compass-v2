import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ChangeLogEntry, Opportunity, Quarter } from '@/types/forecast';
import { getCurrentQuarter } from '@/types/forecast';
import { computeCommitAccuracy, type CommitAccuracyRow as Row } from '@/lib/commitAccuracy';

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

  const { rows, quarters, reps } = useMemo(
    () => computeCommitAccuracy(opportunities, changelog, currentQ),
    [opportunities, changelog, currentQ],
  );

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
