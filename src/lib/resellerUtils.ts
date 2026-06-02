/** Shared reseller name resolution + normalization used by DR parser and main import. */

export function normalizeResellerName(name: string): string {
  return name
    .replace(/,?\s*Inc\.?$/i, '')
    .replace(/,?\s*LLC\.?$/i, '')
    .replace(/,?\s*Corp\.?$/i, '')
    .replace(/,?\s*Ltd\.?$/i, '')
    .replace(/,?\s*Limited$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve a single reseller name from two possible Salesforce fields.
 * - Prefers `Reseller Name` if populated
 * - Falls back to `Distributor - Reseller` (format "Reseller - Distributor"), taking the first part
 * - Returns undefined when both are blank
 */
export function resolveReseller(
  resellerName: string | undefined | null,
  distributorReseller: string | undefined | null,
): string | undefined {
  const r = resellerName?.toString().trim();
  if (r) return normalizeResellerName(r);

  const d = distributorReseller?.toString().trim();
  if (d) {
    const parts = d.split(' - ');
    const first = parts[0]?.trim();
    if (first) return normalizeResellerName(first);
  }

  return undefined;
}
