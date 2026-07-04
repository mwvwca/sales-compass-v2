/**
 * F1 fix: snapshots and changelog rows are keyed by the Salesforce id (the
 * stable external key) rather than the internal UUID. The context cleaners
 * purge any history row whose opportunityId is not a Salesforce id, so rows
 * keyed by internal UUIDs were silently destroyed on every load for the
 * ~51% of opportunities whose internal id is a UUID.
 *
 * Write path: always key new history rows with historyKey(opp).
 * Read path: match on either key (legacy rows and current rows both resolve).
 */

export interface HistoryKeyed {
  id: string;
  salesforceId?: string;
}

/** The stable key under which an opportunity's history is stored. */
export function historyKey(o: HistoryKeyed): string {
  return o.salesforceId || o.id;
}

/** Does a history row's opportunityId belong to this opportunity? */
export function matchesHistoryKey(recordOppId: string, o: HistoryKeyed): boolean {
  return recordOppId === o.salesforceId || recordOppId === o.id;
}

/**
 * Collect rows for an opportunity from an index keyed by opportunityId,
 * covering both the Salesforce id and the internal id without duplicates.
 */
export function rowsForOpportunity<T>(index: Map<string, T[]>, o: HistoryKeyed): T[] {
  const primary = o.salesforceId ? index.get(o.salesforceId) : undefined;
  const secondary = o.id !== o.salesforceId ? index.get(o.id) : undefined;
  if (primary && secondary) return [...primary, ...secondary];
  return primary ?? secondary ?? [];
}
