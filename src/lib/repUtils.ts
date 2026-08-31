/** Roster membership status for an Opportunity Owner. */
export type RepStatus = 'team' | 'not_team';

/**
 * Loose name normalization: lowercased, whitespace-collapsed.
 *
 * This is NOT the roster key. It is retained for the places that match a rep name
 * against free-form or user-typed text (duplicate-name guards in the roster editor,
 * rep-filter matching in the dashboard). Roster membership uses `rosterKey` instead —
 * see `isTeamOwned`.
 */
export function normalizeRepName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The roster key: the "Opportunity Owner" display name, trimmed and otherwise
 * untouched. Matching is exact and CASE-SENSITIVE by design.
 *
 * Deliberately strict. If Salesforce ever renders an existing person's name
 * differently (the Richard/Rich Morris, Matt/Matthew Johnson pattern seen with CAMs),
 * the variant must arrive as a NEW owner — defaulting safely to off-team and
 * surfacing in the new-owner notice for the user to classify — rather than silently
 * matching and splitting a person's deals across two spellings with no signal.
 * No fuzzy matching.
 */
export function rosterKey(name: string | null | undefined): string {
  return String(name ?? '').trim();
}

/**
 * Whether a roster entry counts as on-team.
 *
 * A missing `status` reads as 'team': entries created before the roster gained a
 * status field were, by definition, the hand-maintained team list.
 */
export function isTeamStatus(rep: { status?: RepStatus }): boolean {
  return (rep.status ?? 'team') === 'team';
}

/**
 * The set of on-team owner names, exactly as they must appear in the export.
 *
 * Membership is the roster's `status`, independent of active/inactive — an inactive
 * rep was still on the team. Entries with `status: 'not_team'` (including every owner
 * auto-added at import) are excluded.
 */
export function buildTeamRepNameSet(reps: { name: string; status?: RepStatus }[]): Set<string> {
  const set = new Set<string>();
  for (const r of reps) {
    if (!isTeamStatus(r)) continue;
    const key = rosterKey(r.name);
    if (key) set.add(key);
  }
  return set;
}

/**
 * True when the record's CURRENT owner is on the roster as 'team'.
 *
 * Evaluated at read time from `teamRepNames` — nothing is persisted on the record and
 * nothing is stamped at ingest, so an owner change in a later import, or a roster
 * toggle in the UI, self-corrects on the next render with no reimport.
 *
 * An owner absent from the roster is NOT team-owned. That default is deliberate: an
 * unclassified owner must never silently inflate funnel totals, forecast rollups, or
 * DR cleanup emails.
 */
export function isTeamOwned(record: { repName?: string | null }, teamRepNames: Set<string>): boolean {
  const owner = rosterKey(record?.repName);
  if (!owner) return false;
  return teamRepNames.has(owner);
}

/** Every distinct trimmed owner name present in a set of records. */
export function ownerNamesIn(records: { repName?: string | null }[]): Set<string> {
  const names = new Set<string>();
  for (const r of records) {
    const key = rosterKey(r?.repName);
    if (key) names.add(key);
  }
  return names;
}

/**
 * Owner names that are not yet on the roster. Exact, case-sensitive — a case variant
 * of a known name is intentionally reported as unknown so it surfaces for review.
 */
export function unknownOwnerNames(
  reps: { name: string }[],
  ownerNames: Iterable<string>,
): string[] {
  const known = new Set(reps.map(r => rosterKey(r.name)).filter(Boolean));
  const out: string[] = [];
  for (const raw of ownerNames) {
    const key = rosterKey(raw);
    if (key && !known.has(key)) {
      known.add(key); // dedupe within this batch
      out.push(key);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}
