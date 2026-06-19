import type { ChangeLogEntry, Opportunity, Quarter } from '@/types/forecast';
import { getCurrentQuarter, getQuarter } from '@/types/forecast';

export interface CommitAccuracyRow {
  repName: string;
  quarter: Quarter;
  committedCount: number;
  committedAmount: number;
  closedFromCommitCount: number;
  closedFromCommitAmount: number;
  inProgress: boolean;
}

export interface CommitAccuracyResult {
  rows: CommitAccuracyRow[];
  quarters: Quarter[];
  reps: string[];
}

/**
 * Per-rep, per-quarter commit accuracy: for each quarter a rep committed deals,
 * how many (count + amount) of those committed deals actually closed won in that
 * quarter. Pure over (opportunities, changelog). `currentQ` marks the in-progress
 * quarter (excluded from accuracy totals downstream); overridable for tests.
 */
export function computeCommitAccuracy(
  opportunities: Opportunity[],
  changelog: ChangeLogEntry[],
  currentQ: Quarter = getCurrentQuarter(),
): CommitAccuracyResult {
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

  const rows: CommitAccuracyRow[] = [];
  for (const rep of repsArr) {
    for (const q of quartersArr) {
      const committed = repCommittedByQ.get(rep)?.get(q);
      if (!committed || committed.size === 0) continue;
      const closed = repClosedByQ.get(rep)?.get(q) || new Set<string>();
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
}
