import type { Opportunity, OpportunitySnapshot } from '@/types/forecast';

/**
 * Direct stage-staleness measure for the deal-risk "stage stalled" signal.
 *
 * Replaces the old proxy (`snapshots.length >= 3 && all stages equal`), which counted
 * snapshots surviving signature collapse — not imports, and not stage changes — and
 * under-fires after the v2 rename-collapse heal shrinks those counts.
 */

const normStage = (s: string | undefined): string => (s ?? '').trim().toLowerCase();

type StageSnap = Pick<OpportunitySnapshot, 'stage' | 'importDate'>;

/** Chronological (ascending importDate) snapshot history for one opportunity. */
export function stageHistoryFor(
  opp: Pick<Opportunity, 'id' | 'salesforceId'>,
  snapshots: OpportunitySnapshot[],
): OpportunitySnapshot[] {
  return snapshots
    .filter(s => s.opportunityId === (opp.salesforceId || opp.id) || s.opportunityId === opp.id)
    .sort((a, b) => new Date(a.importDate).getTime() - new Date(b.importDate).getTime());
}

/**
 * ISO date the current stage was reached: the most recent snapshot whose stage differs
 * from the prior snapshot's stage. Falls back to first-seen (earliest snapshot, else the
 * opportunity's importDate) when the stage has never changed across the history.
 */
export function lastStageChangeISO(
  history: StageSnap[],
  opp: Pick<Opportunity, 'importDate'>,
): string | undefined {
  for (let i = history.length - 1; i >= 1; i--) {
    if (normStage(history[i].stage) !== normStage(history[i - 1].stage)) return history[i].importDate;
  }
  return history.length ? history[0].importDate : opp.importDate;
}

/**
 * Whole days since the current stage was reached (see lastStageChangeISO). null when there
 * is no usable anchor date. This is the direct staleness measure the UI reports in days.
 */
export function daysSinceStageChange(
  history: StageSnap[],
  opp: Pick<Opportunity, 'importDate'>,
  now: Date,
): number | null {
  const iso = lastStageChangeISO(history, opp);
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

/** ISO date of the opportunity's most recent snapshot, or undefined when it has none. */
export function lastSnapshotISO(history: Pick<OpportunitySnapshot, 'importDate'>[]): string | undefined {
  return history.length ? history[history.length - 1].importDate : undefined;
}

/**
 * Schema-free approximation of "absent from the most recent import": returns the date of the
 * opportunity's latest snapshot when that snapshot predates the latest import date, else
 * undefined. Every imported opportunity is snapshotted at import time, so a latest snapshot
 * older than the latest import means the deal was not in that import. This is an interim
 * stand-in for a real `consecutiveMissedImports >= 1` absence flag: once that lands, swap it in.
 */
export function absentFromLatestImport(
  history: Pick<OpportunitySnapshot, 'importDate'>[],
  latestImportDate: string | undefined,
): string | undefined {
  const last = lastSnapshotISO(history);
  if (!last || !latestImportDate) return undefined;
  return last < latestImportDate ? last : undefined;
}

/** The retired proxy rule, kept only to report old-vs-new coverage. */
export function oldStageStuckFires(history: StageSnap[]): boolean {
  if (history.length < 3) return false;
  return new Set(history.map(h => normStage(h.stage))).size === 1;
}

export interface StageSignalComparison {
  oldFire: string[];
  newFire: string[];
  overlap: number;
  oldOnly: number;
  newOnly: number;
  /** Open deals whose latest snapshot predates the latest import (absence proxy). */
  absent: number;
  /** Of newFire, how many are absent — relabeled "not seen since" rather than stalled. */
  relabeled: number;
}

/**
 * Compare which open opportunities fire the old proxy vs the new days-based rule on the
 * same (already-healed) snapshot data, and how many the absence proxy would relabel.
 * `openOpps` should already exclude resolved AND non-team-owned deals. `latestImportDate`
 * (the most recent opportunity-import date) enables the absence approximation.
 */
export function compareStageStaleSignal(
  openOpps: Opportunity[],
  snapshots: OpportunitySnapshot[],
  staleDays: number,
  now: Date,
  latestImportDate?: string,
): StageSignalComparison {
  const oldFire: string[] = [];
  const newFire: string[] = [];
  let absent = 0;
  let relabeled = 0;
  for (const opp of openOpps) {
    const history = stageHistoryFor(opp, snapshots);
    if (oldStageStuckFires(history)) oldFire.push(opp.id);
    const days = daysSinceStageChange(history, opp, now);
    const fires = days !== null && days >= staleDays;
    if (fires) newFire.push(opp.id);
    const isAbsent = !!absentFromLatestImport(history, latestImportDate);
    if (isAbsent) absent++;
    if (fires && isAbsent) relabeled++;
  }
  const newSet = new Set(newFire);
  const overlap = oldFire.filter(id => newSet.has(id)).length;
  return { oldFire, newFire, overlap, oldOnly: oldFire.length - overlap, newOnly: newFire.length - overlap, absent, relabeled };
}
