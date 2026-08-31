import type { Opportunity } from '@/types/forecast';
import { isTeamOwned, rosterKey } from './repUtils';

/**
 * Forecast-import ingest gate.
 *
 * A wide-scope export carries every owner in the report's filter, not just the team.
 * Without a bound, one such file stores tens of thousands of foreign records: the
 * 2026-08-31 import took stored opportunities from 2,561 to 7,319.
 *
 * The rule is deliberately narrow — a row is admitted only if:
 *   1. its owner is on the roster with status 'team', or
 *   2. its Opportunity ID already exists in stored records (a deal the app has
 *      legitimately tracked, which may since have been reassigned off-team — that
 *      history must not be dropped just because the owner changed).
 *
 * Everything else is discarded before any merge, so it produces no opportunity
 * record, no changelog entry, and no snapshot entry.
 *
 * Discarding is NOT the same as ignoring: the owner name on every discarded row is
 * still collected, so roster auto-add and the new-owner notice behave exactly as if
 * the row had been ingested. Membership stays a decision the user makes, and a
 * newly-classified team member's deals arrive on the next import.
 */

export type GateVerdict = 'team' | 'known-id' | 'discard';

export interface GateCounts {
  /** Admitted because the owner is on the roster as 'team'. */
  keptTeam: number;
  /** Admitted because the Opportunity ID is already stored (owner may be off-team). */
  keptKnownId: number;
  /** Rejected: owner not on the team and the ID has never been seen. */
  discarded: number;
}

export interface GateResult {
  kept: Opportunity[];
  counts: GateCounts;
  /** Distinct owner names seen on discarded rows, for roster auto-add + notice. */
  discardedOwners: string[];
  /** Discarded row count per owner, for reporting. */
  discardedByOwner: Record<string, number>;
}

/**
 * Every Opportunity ID the app already holds.
 *
 * Built from `salesforceId` plus any `id` that is itself a Salesforce id — mirroring
 * the merge's own existing-record lookup, so the gate can never discard a row the
 * merge would have matched to a stored record.
 */
export function buildKnownIdSet(stored: Pick<Opportunity, 'id' | 'salesforceId'>[]): Set<string> {
  const ids = new Set<string>();
  for (const o of stored) {
    if (o.salesforceId) ids.add(o.salesforceId);
    if (o.id) ids.add(o.id);
  }
  return ids;
}

/** Decide one row. Team membership wins, so the counters never double-count. */
export function gateVerdict(
  row: Pick<Opportunity, 'repName' | 'id' | 'salesforceId'>,
  teamRepNames: Set<string>,
  knownIds: Set<string>,
): GateVerdict {
  if (isTeamOwned(row, teamRepNames)) return 'team';
  const sfid = row.salesforceId ?? row.id;
  if (sfid && knownIds.has(sfid)) return 'known-id';
  return 'discard';
}

/**
 * Run parsed rows through the gate. Pure — takes the roster and stored-id sets as
 * inputs so it can be previewed in the import review and applied at merge time from
 * the same code path.
 */
export function applyIngestGate(
  rows: Opportunity[],
  teamRepNames: Set<string>,
  knownIds: Set<string>,
): GateResult {
  const kept: Opportunity[] = [];
  const counts: GateCounts = { keptTeam: 0, keptKnownId: 0, discarded: 0 };
  const discardedByOwner: Record<string, number> = {};

  for (const row of rows) {
    const verdict = gateVerdict(row, teamRepNames, knownIds);
    if (verdict === 'team') {
      counts.keptTeam++;
      kept.push(row);
    } else if (verdict === 'known-id') {
      counts.keptKnownId++;
      kept.push(row);
    } else {
      counts.discarded++;
      // Owner still recorded — roster auto-add and the new-owner notice must see
      // every owner in the file, whether or not the row itself was admitted.
      const owner = rosterKey(row.repName);
      if (owner) discardedByOwner[owner] = (discardedByOwner[owner] ?? 0) + 1;
    }
  }

  return {
    kept,
    counts,
    discardedOwners: Object.keys(discardedByOwner).sort((a, b) => a.localeCompare(b)),
    discardedByOwner,
  };
}

/** One-line summary for toasts and the import log. */
export function formatGateCounts(c: GateCounts): string {
  return `${c.keptTeam} team · ${c.keptKnownId} known ID · ${c.discarded} discarded`;
}
