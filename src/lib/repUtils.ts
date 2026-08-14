export function normalizeRepName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Build the set of normalized names for the configured rep roster (the "team").
 * Membership is the full roster regardless of active/inactive status — an inactive
 * rep was still on the team; a name absent from the roster entirely is off-team.
 * Uses the SAME normalization (`normalizeRepName`) as every other rep match, so
 * there is only one name-matching convention.
 */
export function buildTeamRepNameSet(reps: { name: string }[]): Set<string> {
  return new Set(reps.map(r => normalizeRepName(r.name)));
}

/**
 * True when the record's CURRENT owner (repName) is on the configured rep roster.
 *
 * Derived at read time from `teamRepNames` — nothing is persisted on the record and
 * nothing is stamped at ingest, so an owner change in a later import self-corrects.
 * A record with no owner, or an owner not on the roster (e.g. an import that carried
 * in someone off-team), is treated as NOT team-owned.
 */
export function isTeamOwned(record: { repName?: string | null }, teamRepNames: Set<string>): boolean {
  const owner = record?.repName?.trim();
  if (!owner) return false;
  return teamRepNames.has(normalizeRepName(owner));
}
