/**
 * Direct-link helpers for Salesforce opportunities.
 *
 * The pipeline export ideally carries a hyperlink on the Opportunity Name cell.
 * When it doesn't, we reconstruct a Lightning URL from the record's Salesforce
 * id — but only if we can learn the org's origin from some other hyperlink in
 * the same dataset (an opportunity or account URL). No origin, no reconstruction.
 */

/** First parseable origin (scheme + host) from a list of candidate URLs, else undefined. */
export function originFromUrls(urls: Array<string | undefined | null>): string | undefined {
  for (const u of urls) {
    if (!u) continue;
    try {
      return new URL(String(u)).origin;
    } catch {
      /* not an absolute URL — keep looking */
    }
  }
  return undefined;
}

/** Lightning record URL for an opportunity given the org origin. */
export function buildOpportunityUrl(salesforceId: string, origin: string): string {
  return `${origin}/lightning/r/Opportunity/${salesforceId}/view`;
}

/**
 * Resolve the best available opportunity URL: an explicit hyperlink always wins;
 * otherwise construct one from the Salesforce id and a derived origin; if neither
 * is available, return undefined.
 */
export function resolveOpportunityUrl(
  hyperlink: string | undefined | null,
  salesforceId: string | undefined | null,
  origin: string | undefined | null,
): string | undefined {
  const link = hyperlink ? String(hyperlink).trim() : '';
  if (link) return link;
  if (salesforceId && origin) return buildOpportunityUrl(String(salesforceId), String(origin));
  return undefined;
}
