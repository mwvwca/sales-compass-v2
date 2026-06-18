const SFDC_INSTANCE = 'logicnow';

export const sfdcUrl = (type: 'Opportunity' | 'Account', id: string) =>
  `https://${SFDC_INSTANCE}.lightning.force.com/lightning/r/${type}/${id}/view`;

export const sfdcOpportunityUrl = (opportunityId: string) =>
  sfdcUrl('Opportunity', opportunityId);

// accountUrl is captured in classic form (.../001Vy00001duKY9IAM). Pull the
// 001 Account ID out and rebuild as a Lightning link; fall back to the raw URL.
export const sfdcAccountUrl = (accountUrl?: string) => {
  const id = accountUrl?.match(/\/(001[A-Za-z0-9]{12,15})(?:[/?#]|$)/)?.[1];
  return id ? sfdcUrl('Account', id) : accountUrl;
};

/**
 * Opportunities carry no account URL, but registered deals (DRs) do. Build a
 * lookup from Salesforce Opportunity ID → Lightning account URL using a DR
 * export's stored accountUrl, so opportunity-based surfaces (forecast list,
 * exports, briefing) can still link the account. Keyed by the canonical 15-char
 * Opportunity ID so 15- and 18-char IDs join.
 */
export function buildAccountUrlMap(
  drs: { opportunityId?: string; accountUrl?: string }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const d of drs) {
    if (!d.opportunityId) continue;
    const url = sfdcAccountUrl(d.accountUrl);
    if (url) map.set(d.opportunityId.slice(0, 15), url);
  }
  return map;
}

/** Resolve an opportunity's account Lightning URL from the DR-derived map. */
export const accountUrlForOpportunity = (
  opportunityId: string | undefined,
  map: Map<string, string>,
): string | undefined => (opportunityId ? map.get(opportunityId.slice(0, 15)) : undefined);
