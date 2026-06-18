import { describe, it, expect } from 'vitest';
import {
  sfdcOpportunityUrl,
  sfdcAccountUrl,
  buildAccountUrlMap,
  accountUrlForOpportunity,
} from '@/lib/sfdc';

const BASE = 'https://logicnow.lightning.force.com/lightning/r';

describe('sfdc links', () => {
  it('builds a Lightning opportunity URL, passing 15/18-char ids as-is', () => {
    expect(sfdcOpportunityUrl('006Vy00001cDDU6')).toBe(`${BASE}/Opportunity/006Vy00001cDDU6/view`);
    expect(sfdcOpportunityUrl('006Vy00001cDDU6AAF')).toBe(`${BASE}/Opportunity/006Vy00001cDDU6AAF/view`);
  });

  it('rebuilds a classic account URL into a Lightning link via the 001 id', () => {
    expect(sfdcAccountUrl('https://logicnow.my.salesforce.com/001Vy00001duKY9IAM'))
      .toBe(`${BASE}/Account/001Vy00001duKY9IAM/view`);
  });

  it('falls back to the raw URL when no 001 id is present, undefined when absent', () => {
    expect(sfdcAccountUrl('https://example.com/foo')).toBe('https://example.com/foo');
    expect(sfdcAccountUrl(undefined)).toBeUndefined();
  });

  it('derives account links for opportunities from DR accountUrls, joining 15↔18 char ids', () => {
    const map = buildAccountUrlMap([
      { opportunityId: '006Vy00001cDDU6', accountUrl: 'https://logicnow.my.salesforce.com/001Vy00001duKY9IAM' },
      { opportunityId: '006Vy00001Zh7Hi', accountUrl: undefined }, // no url → not mapped
    ]);
    // 18-char opportunity id resolves against the 15-char-keyed map
    expect(accountUrlForOpportunity('006Vy00001cDDU6AAF', map)).toBe(`${BASE}/Account/001Vy00001duKY9IAM/view`);
    expect(accountUrlForOpportunity('006Vy00001Zh7Hi', map)).toBeUndefined();
    expect(accountUrlForOpportunity(undefined, map)).toBeUndefined();
  });
});
