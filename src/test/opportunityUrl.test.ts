import { describe, it, expect } from 'vitest';
import { originFromUrls, buildOpportunityUrl, resolveOpportunityUrl } from '@/lib/opportunityUrl';

describe('originFromUrls', () => {
  it('returns the origin of the first parseable URL', () => {
    expect(originFromUrls(['https://acme.my.salesforce.com/lightning/r/Opportunity/006X/view']))
      .toBe('https://acme.my.salesforce.com');
  });

  it('skips blanks and non-URLs', () => {
    expect(originFromUrls([undefined, '', 'not a url', 'https://acme.lightning.force.com/x']))
      .toBe('https://acme.lightning.force.com');
  });

  it('returns undefined when no derivable origin exists', () => {
    expect(originFromUrls([undefined, '', 'Acme Corp'])).toBeUndefined();
  });
});

describe('buildOpportunityUrl', () => {
  it('builds a Lightning record URL from origin + salesforceId', () => {
    expect(buildOpportunityUrl('006Vy000017OsIs', 'https://acme.my.salesforce.com'))
      .toBe('https://acme.my.salesforce.com/lightning/r/Opportunity/006Vy000017OsIs/view');
  });
});

describe('resolveOpportunityUrl', () => {
  it('prefers an explicit hyperlink over a constructed URL', () => {
    const url = resolveOpportunityUrl(
      'https://acme.my.salesforce.com/lightning/r/Opportunity/HYPERLINK/view',
      '006Vy000017OsIs',
      'https://acme.my.salesforce.com',
    );
    expect(url).toBe('https://acme.my.salesforce.com/lightning/r/Opportunity/HYPERLINK/view');
  });

  it('constructs from salesforceId + derived origin when no hyperlink is present', () => {
    // Mirrors the parser: derive origin from another row, then construct this row's URL.
    const origin = originFromUrls(['https://acme.my.salesforce.com/lightning/r/Account/001X/view']);
    const url = resolveOpportunityUrl(undefined, '006Vy000017OsIs', origin);
    expect(url).toBe('https://acme.my.salesforce.com/lightning/r/Opportunity/006Vy000017OsIs/view');
  });

  it('returns undefined when neither a hyperlink nor a derivable origin exists', () => {
    expect(resolveOpportunityUrl(undefined, '006Vy000017OsIs', undefined)).toBeUndefined();
    expect(resolveOpportunityUrl(undefined, undefined, 'https://acme.my.salesforce.com')).toBeUndefined();
  });
});
