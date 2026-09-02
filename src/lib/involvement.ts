import type { Opportunity } from '@/types/forecast';

/**
 * Manager-involvement tracking for the Friday briefing.
 *
 * Where the manager stands on a deal is a MANAGER-entered fact — Salesforce has no
 * column for it — so it is stored in its own app_state slice (`forecast_involvement`)
 * keyed on the Salesforce Opportunity ID, never on the opportunity record. The import
 * merge replaces every field on a stored opportunity from the incoming export
 * (see ForecastContext.importOpportunities), so anything written onto the record would
 * be erased by the next Friday's import. Keyed on the Salesforce id rather than the
 * internal UUID because the UUID is minted per record while the Salesforce id is the
 * stable join key across imports, backups and DR merges.
 *
 * Joined to the deal at render time. An entry with no matching opportunity is harmless
 * (a deal that closed or left the book) and is deliberately NOT garbage-collected: the
 * deal can come back, and the manager's history of it should come back with it.
 */

export type InvolvementStatus = 'not_yet' | 'scheduled' | 'introduced';

export interface InvolvementEntry {
  status: InvolvementStatus;
  /** ISO date (YYYY-MM-DD) the scheduled/introduced status refers to. Empty for not_yet. */
  date: string;
  /** One-line "my role" note — what the manager is actually doing on this deal. */
  note: string;
  /** ISO timestamp of the last edit. */
  updatedAt: string;
}

/** salesforceId → involvement. Never null: an empty object IS "nothing tracked yet". */
export type InvolvementMap = Record<string, InvolvementEntry>;

export const NO_INVOLVEMENT: InvolvementEntry = { status: 'not_yet', date: '', note: '', updatedAt: '' };

export const INVOLVEMENT_ORDER: InvolvementStatus[] = ['not_yet', 'scheduled', 'introduced'];

export const INVOLVEMENT_META: Record<InvolvementStatus, { label: string; short: string; tone: string }> = {
  not_yet: { label: 'Not yet', short: 'not yet', tone: 'bg-secondary/60 text-muted-foreground' },
  scheduled: { label: 'Scheduled', short: 'scheduled', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  introduced: { label: 'Introduced', short: 'introduced', tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' },
};

/** The involvement key for a deal: the Salesforce id, falling back to the internal id. */
export function involvementKey(opp: Pick<Opportunity, 'id' | 'salesforceId'>): string {
  return opp.salesforceId || opp.id;
}

/** Involvement for one deal, or the neutral default. Never returns undefined. */
export function involvementFor(map: InvolvementMap, key: string): InvolvementEntry {
  return map[key] ?? NO_INVOLVEMENT;
}

/** Next status in the three-state cycle: not_yet → scheduled → introduced → not_yet. */
export function nextInvolvementStatus(status: InvolvementStatus): InvolvementStatus {
  const i = INVOLVEMENT_ORDER.indexOf(status);
  return INVOLVEMENT_ORDER[(i + 1) % INVOLVEMENT_ORDER.length];
}

/**
 * Apply a patch to one deal's involvement, stamping updatedAt.
 *
 * Moving to a dated status with no date yet stamps today, so "scheduled"/"introduced"
 * always carries the day it happened without a second click; returning to not_yet
 * clears the date because there is no event to date. An explicit `date` in the patch
 * always wins, so the manager can correct it.
 */
export function applyInvolvement(
  map: InvolvementMap,
  key: string,
  patch: Partial<Pick<InvolvementEntry, 'status' | 'date' | 'note'>>,
  now: Date = new Date(),
): InvolvementMap {
  const prev = involvementFor(map, key);
  const status = patch.status ?? prev.status;
  const today = now.toISOString().slice(0, 10);
  let date = patch.date ?? prev.date;
  if (patch.date === undefined) {
    if (status === 'not_yet') date = '';
    else if (!prev.date || prev.status !== status) date = today;
  }
  return {
    ...map,
    [key]: {
      status,
      date,
      note: patch.note ?? prev.note,
      updatedAt: now.toISOString(),
    },
  };
}

/** Cleaner for the persisted slice: drops anything that is not a usable entry. */
export function cleanInvolvement(raw: unknown): InvolvementMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: InvolvementMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !value || typeof value !== 'object') continue;
    const v = value as Partial<InvolvementEntry>;
    const status: InvolvementStatus = INVOLVEMENT_ORDER.includes(v.status as InvolvementStatus)
      ? (v.status as InvolvementStatus)
      : 'not_yet';
    out[key] = {
      status,
      date: typeof v.date === 'string' ? v.date : '',
      note: typeof v.note === 'string' ? v.note : '',
      updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
    };
  }
  return out;
}
