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
