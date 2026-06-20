/** Open a deal's unified 360 view. `identifier` may be an Opportunity.id or a
 *  Salesforce id — the deal view resolves either. Fires the window event that
 *  Index listens for to switch to the Search tab and select the deal. */
export function openOpportunity(identifier: string): void {
  window.dispatchEvent(new CustomEvent('forecast:open-opportunity', { detail: identifier }));
}
