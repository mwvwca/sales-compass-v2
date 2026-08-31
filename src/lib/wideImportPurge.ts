import type { Opportunity, ChangeLogEntry, OpportunitySnapshot, Rep } from '@/types/forecast';
import { buildTeamRepNameSet, isTeamOwned } from './repUtils';

/**
 * One-time purge of the foreign records admitted by the 2026-08-31 wide import.
 *
 * That import ran before the ingest gate existed, so a wide-scope forecast export
 * stored every owner's entire book: opportunities went from 2,561 to 7,319, with 14
 * non-team owners contributing thousands of records each.
 *
 * A record is removed only if ALL THREE hold:
 *   1. its current owner's roster status is 'not_team', AND
 *   2. it first appeared on that import (importDate on 2026-08-31 at or after 20:00Z), AND
 *   3. it has no changelog entry predating that import.
 *
 * Failing any condition keeps the record. Conditions 2 and 3 are independently
 * sufficient to protect a legitimately-tracked deal that has merely been reassigned
 * off-team — e.g. 006Vy00000nstHq (Deal Reg - LRT - Avreo - Vandis - Adlumin), now
 * owned by Dan Culleton and Closed Lost, but first imported in June 2026 with prior
 * changelog history. Its importDate is June, so (2) already excludes it; its prior
 * history excludes it again under (3).
 *
 * Changelog and snapshot rows for purged ids go too, so compaction and storage
 * actually shrink. Deal registrations are untouched — the wide file was forecast-only.
 */

/** Records first seen at or after this instant are candidates. */
export const WIDE_IMPORT_CUTOFF = '2026-08-31T20:00:00.000Z';
/** Upper bound of the wide-import window (end of that UTC day). */
export const WIDE_IMPORT_WINDOW_END = '2026-09-01T00:00:00.000Z';

/** Sanity band on the removal set. Outside it, the purge refuses to run. */
export const PURGE_MIN = 4000;
export const PURGE_MAX = 5000;

export interface PurgePlan {
  /** salesforceIds (or ids) of the opportunities to remove. */
  removeIds: Set<string>;
  /** Internal record ids to remove. */
  removeRecordIds: Set<string>;
  removedByOwner: Record<string, number>;
  counts: {
    opportunitiesBefore: number;
    opportunitiesRemoved: number;
    opportunitiesAfter: number;
    changelogRemoved: number;
    snapshotsRemoved: number;
  };
  /** False when the removal set falls outside the sanity band — do not apply. */
  withinBand: boolean;
}

const inWideImportWindow = (iso: string | undefined): boolean =>
  !!iso && iso >= WIDE_IMPORT_CUTOFF && iso < WIDE_IMPORT_WINDOW_END;

/**
 * Compute the purge without applying it. Pure, so the sanity band can be checked and
 * the breakdown reported before anything is deleted.
 */
export function planWideImportPurge(
  opportunities: Opportunity[],
  changelog: ChangeLogEntry[],
  snapshots: OpportunitySnapshot[],
  reps: Rep[],
): PurgePlan {
  const teamRepNames = buildTeamRepNameSet(reps);

  // Earliest changelog entry per opportunity id, to test "no history before the import".
  const earliestChange = new Map<string, string>();
  for (const e of changelog) {
    if (!e.opportunityId || !e.importDate) continue;
    const cur = earliestChange.get(e.opportunityId);
    if (!cur || e.importDate < cur) earliestChange.set(e.opportunityId, e.importDate);
  }

  const removeIds = new Set<string>();
  const removeRecordIds = new Set<string>();
  const removedByOwner: Record<string, number> = {};

  for (const o of opportunities) {
    // 1. Owner must be off the team roster.
    if (isTeamOwned(o, teamRepNames)) continue;
    // 2. Must have first appeared on the wide import.
    if (!inWideImportWindow(o.importDate)) continue;
    // 3. Must have no changelog history predating that import.
    const histKey = o.salesforceId ?? o.id;
    const earliest = earliestChange.get(histKey);
    if (earliest && earliest < WIDE_IMPORT_CUTOFF) continue;

    removeIds.add(histKey);
    removeRecordIds.add(o.id);
    const owner = (o.repName ?? '').trim() || '(no owner)';
    removedByOwner[owner] = (removedByOwner[owner] ?? 0) + 1;
  }

  const changelogRemoved = changelog.filter(e => removeIds.has(e.opportunityId)).length;
  const snapshotsRemoved = snapshots.filter(s => removeIds.has(s.opportunityId)).length;

  return {
    removeIds,
    removeRecordIds,
    removedByOwner,
    counts: {
      opportunitiesBefore: opportunities.length,
      opportunitiesRemoved: removeRecordIds.size,
      opportunitiesAfter: opportunities.length - removeRecordIds.size,
      changelogRemoved,
      snapshotsRemoved,
    },
    withinBand: removeRecordIds.size >= PURGE_MIN && removeRecordIds.size <= PURGE_MAX,
  };
}

/** Apply a plan. Deal registrations are deliberately not part of this. */
export function applyWideImportPurge(
  plan: PurgePlan,
  opportunities: Opportunity[],
  changelog: ChangeLogEntry[],
  snapshots: OpportunitySnapshot[],
): { opportunities: Opportunity[]; changelog: ChangeLogEntry[]; snapshots: OpportunitySnapshot[] } {
  return {
    opportunities: opportunities.filter(o => !plan.removeRecordIds.has(o.id)),
    changelog: changelog.filter(e => !plan.removeIds.has(e.opportunityId)),
    snapshots: snapshots.filter(s => !plan.removeIds.has(s.opportunityId)),
  };
}

/** Owner breakdown, largest first — what gets reported when the band check fails. */
export function purgeBreakdown(plan: PurgePlan): string {
  return Object.entries(plan.removedByOwner)
    .sort((a, b) => b[1] - a[1])
    .map(([owner, n]) => `${owner}: ${n}`)
    .join(', ');
}
