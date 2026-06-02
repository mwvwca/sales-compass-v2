/** Shared reseller name resolution + normalization used by DR parser and main import. */

export function normalizeResellerName(name: string): string {
  return name
    .replace(/,?\s*Inc\.?$/i, '')
    .replace(/,?\s*LLC\.?$/i, '')
    .replace(/,?\s*Corp\.?$/i, '')
    .replace(/,?\s*Ltd\.?$/i, '')
    .replace(/,?\s*Limited$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bEplus\b/gi, 'ePlus')
    .replace(/\bBorderlan\b/gi, 'BorderLAN')
    .replace(/\bCdw\b/g, 'CDW')
    .replace(/\bShi\b/g, 'SHI')
    .replace(/\bSsa\b/g, 'SSA')
    .replace(/\bVlcm\b/g, 'VLCM')
    .replace(/\bMnj\b/g, 'MNJ')
    .replace(/\bBw\b/g, 'BW')
    .replace(/\bIt\b/g, 'IT')
    .replace(/\bAti\b/g, 'ATI')
    .replace(/\bGrm\b/g, 'GRM')
    .replace(/\bTrace3\b/gi, 'Trace3');
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
