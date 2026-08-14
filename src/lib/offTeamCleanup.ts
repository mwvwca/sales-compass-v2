import type { DealRegistration, DrBatch, Opportunity, Rep } from '@/types/forecast';
import { buildTeamRepNameSet, isTeamOwned } from './repUtils';

/**
 * One-time cleanup of records left behind by the bad 8/10 import: rows owned by
 * someone off the rep roster that were first seen on that import. Rows whose off-team
 * owner arrived earlier (a genuine transfer-out of a previously team-owned deal) are
 * retained. Pure functions — return the surviving list plus deleted/retained counts.
 */

/** As-of / import date of the 8/10 import being cleaned up. */
export const OFFTEAM_CLEANUP_AS_OF = '2026-08-10';

/**
 * Delete DRs that are (a) owned by someone off the roster AND (b) first seen on a
 * batch whose asOfDate is the 8/10 import. `retained` counts the off-team DRs kept
 * because they were first seen on an earlier batch (previously team-owned).
 */
export function cleanupOffTeamDrs(
  drs: DealRegistration[],
  batches: DrBatch[],
  reps: Rep[],
  asOf: string = OFFTEAM_CLEANUP_AS_OF,
): { drs: DealRegistration[]; deleted: number; retained: number } {
  const team = buildTeamRepNameSet(reps);
  const targetBatchIds = new Set(batches.filter(b => b.asOfDate === asOf).map(b => b.id));
  let deleted = 0;
  let retained = 0;
  const next: DealRegistration[] = [];
  for (const d of drs) {
    if (!isTeamOwned(d, team)) {
      if (targetBatchIds.has(d.batchIdFirstSeen)) { deleted++; continue; }
      retained++;
    }
    next.push(d);
  }
  return { drs: next, deleted, retained };
}

/**
 * Delete opportunities that are (a) owned by someone off the roster AND (b) first
 * imported on the 8/10 import (importDate is preserved from first import). `retained`
 * counts the off-team opps kept because they were first imported earlier.
 */
export function cleanupOffTeamOpps(
  opps: Opportunity[],
  reps: Rep[],
  asOf: string = OFFTEAM_CLEANUP_AS_OF,
): { opps: Opportunity[]; deleted: number; retained: number } {
  const team = buildTeamRepNameSet(reps);
  let deleted = 0;
  let retained = 0;
  const next: Opportunity[] = [];
  for (const o of opps) {
    if (!isTeamOwned(o, team)) {
      if ((o.importDate || '').slice(0, 10) === asOf) { deleted++; continue; }
      retained++;
    }
    next.push(o);
  }
  return { opps: next, deleted, retained };
}
