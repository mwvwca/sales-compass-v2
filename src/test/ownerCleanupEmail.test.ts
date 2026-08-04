import { describe, it, expect } from 'vitest';
import { buildOwnerCleanupEmail, isLongRange, type OwnerCleanupGroup } from '@/lib/drCleanup';
import type { CleanupClassification } from '@/lib/drCleanup';
import type { DealRegistration } from '@/types/forecast';

const dr = (over: Partial<DealRegistration>): DealRegistration => ({
  opportunityId: '006Vy00000abc01', opportunityName: 'Deal', accountName: 'Acme Inc',
  repName: 'Sami Khudair', stage: 'Qualified', probability: 0.05, amount: 1000,
  closeDate: '2026-10-15', product: 'MDR - Advance', resolvedReseller: 'ePlus',
  createdDate: '2026-01-01', status: 'active', stageHistory: [], ...over,
} as DealRegistration);

const item = (over: Partial<DealRegistration>, daysSinceActivity = 30): CleanupClassification => ({
  dr: dr(over), anchorRole: 'single', cleanupStage: 'partner_outreach', daysSinceActivity,
  immediateAction: false, recommendedAction: '', everQualified: false, accountRegCount: 1,
});

const group = (deals: CleanupClassification[]): OwnerCleanupGroup => ({
  owner: 'Sami Khudair', ownerEmail: 'sami.khudair@n-able.com', deals,
});

describe('isLongRange', () => {
  it('matches an LRT token, not arbitrary substrings', () => {
    expect(isLongRange('LRT - Finanta Credit Union - EDR')).toBe(true);
    expect(isLongRange('Acme - MDR')).toBe(false);
    expect(isLongRange('ALERT System - MDR')).toBe(false);
    expect(isLongRange(undefined)).toBe(false);
  });
});

describe('buildOwnerCleanupEmail', () => {
  const std = item({ opportunityId: '006Vy00000std01', opportunityName: 'Acme Corp - MDR' });
  const lr = item({ opportunityId: '006Vy00000lrt01', opportunityName: 'LRT - BigCo - MDR' });
  const email = buildOwnerCleanupEmail(group([std, lr]), 'Aug 19, 2026');

  it('shows the opportunity name (not the account) in the table', () => {
    expect(email.body).toContain('Opportunity');
    expect(email.body).toContain('Acme Corp - MDR');
    expect(email.body).not.toContain('Acme Inc');      // account name must not appear
  });

  it('links the opportunity to Salesforce in the HTML', () => {
    expect(email.html).toContain('/lightning/r/Opportunity/006Vy00000std01/view');
    expect(email.html).toMatch(/<a href="[^"]*Opportunity\/006Vy00000std01\/view"[^>]*>Acme Corp - MDR<\/a>/);
  });

  it('splits LRT into its own Long Range section, not the confirm-or-close list', () => {
    expect(email.subject).toContain('1 registration to confirm or close by Aug 19, 2026');
    expect(email.subject).toContain('1 long range');
    // The LRT deal appears under the Long Range heading, after it.
    const lrIdx = email.body.indexOf('Long Range (LRT)');
    expect(lrIdx).toBeGreaterThan(-1);
    expect(email.body.indexOf('LRT - BigCo - MDR')).toBeGreaterThan(lrIdx);
    // The standard deal appears before the LRT heading.
    expect(email.body.indexOf('Acme Corp - MDR')).toBeLessThan(lrIdx);
  });

  it('omits the confirm-or-close section entirely when an owner has only LRT deals', () => {
    const onlyLr = buildOwnerCleanupEmail(group([lr]), 'Aug 19, 2026');
    expect(onlyLr.subject).toBe('Deal registration cleanup — 1 long range');
    expect(onlyLr.body).not.toContain('confirm');
    expect(onlyLr.body).toContain('Long Range (LRT)');
  });
});
