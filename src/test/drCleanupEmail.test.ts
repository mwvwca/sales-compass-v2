import { describe, it, expect } from 'vitest';
import { buildCleanupEmail, isActionable, type CamCleanupGroup, type CleanupClassification } from '@/lib/drCleanup';
import type { DealRegistration } from '@/types/forecast';

function dr(over: Partial<DealRegistration> = {}): DealRegistration {
  return {
    accountName: 'Acme',
    accountUrl: 'https://logicnow.my.salesforce.com/001Vy00001duKY9IAM',
    repName: 'Jane Doe',
    opportunityName: 'Acme — Deal',
    product: 'RMM',
    stage: 'Discovery',
    probability: 0.25,
    ...over,
  } as DealRegistration;
}

function cls(over: Partial<CleanupClassification> & { dr?: Partial<DealRegistration> } = {}): CleanupClassification {
  const { dr: drOver, ...rest } = over;
  return {
    dr: dr(drOver),
    anchorRole: 'single',
    cleanupStage: 'ready_to_close',
    daysSinceActivity: 50,
    immediateAction: false,
    recommendedAction: '',
    accountRegCount: 1,
    ...rest,
  } as CleanupClassification;
}

function group(deals: CleanupClassification[]): CamCleanupGroup {
  return {
    cam: 'Bob Smith',
    camEmail: 'bob.smith@n-able.com',
    deals,
    aeEmails: ['jane.doe@n-able.com'],
    stageCounts: { monitoring: 0, partner_outreach: 0, final_notice: 0, ready_to_close: 0, exempt: 0 },
    immediateCount: 0,
  };
}

describe('buildCleanupEmail re-bucketing', () => {
  it('keeps orphan clusters (immediateAction) out of Closing — even when not 45+ days', () => {
    const close = cls({ cleanupStage: 'ready_to_close', daysSinceActivity: 50, dr: { accountName: 'CloseCo', opportunityName: 'CloseCo Deal' } });
    const orphan = cls({ cleanupStage: 'partner_outreach', daysSinceActivity: 17, immediateAction: true, anchorRole: 'orphan_cluster', accountRegCount: 3, dr: { accountName: 'OrphanCo' } });

    const { body, html } = buildCleanupEmail(group([close, orphan]));

    // Totals line proves the split: orphan is "need attention", not closing/outreach.
    expect(body).toContain('1 closing · 0 final notice · 0 outreach · 1 need attention');
    // Closing section is genuinely 45+ days and excludes the 17-day orphan.
    expect(body).toContain('Closing — being closed, no response needed (45+ days)');
    expect(body).toContain('CloseCo');
    expect(body).toContain('Needs attention — no activity on any registration; engage or close');
    expect(body).toContain('OrphanCo — 3 regs, no activity · 17d');
    // The orphan must not be listed under Closing.
    const closingChunk = body.slice(body.indexOf('Closing —'), body.indexOf('Needs attention —'));
    expect(closingChunk).not.toContain('OrphanCo');

    // HTML links the account name via the Lightning account URL; plain has no URL.
    expect(html).toContain('<a href="https://logicnow.lightning.force.com/lightning/r/Account/001Vy00001duKY9IAM/view" target="_blank" rel="noopener">CloseCo</a>');
    expect(body).not.toContain('http');
  });

  it('dedupes Needs attention to one row per account', () => {
    const a1 = cls({ immediateAction: true, anchorRole: 'orphan_cluster', accountRegCount: 4, dr: { accountName: 'DupCo', opportunityName: 'DupCo Deal 1' } });
    const a2 = cls({ immediateAction: true, anchorRole: 'orphan_cluster', accountRegCount: 4, dr: { accountName: 'DupCo', opportunityName: 'DupCo Deal 2' } });
    const { body } = buildCleanupEmail(group([a1, a2]));
    expect((body.match(/DupCo/g) || []).length).toBe(1);
    expect(body).toContain('0 closing · 0 final notice · 0 outreach · 1 need attention');
  });
});

describe('isActionable / actionable subject count', () => {
  it('is false when a group has only monitoring registrations', () => {
    const g = group([
      cls({ cleanupStage: 'monitoring', daysSinceActivity: 5, dr: { accountName: 'MonCo' } }),
      cls({ cleanupStage: 'monitoring', daysSinceActivity: 3, dr: { accountName: 'MonCo2' } }),
    ]);
    expect(isActionable(g)).toBe(false);
  });

  it('is true when at least one registration is past monitoring', () => {
    const g = group([
      cls({ cleanupStage: 'monitoring', daysSinceActivity: 5 }),
      cls({ cleanupStage: 'final_notice', daysSinceActivity: 35 }),
    ]);
    expect(isActionable(g)).toBe(true);
  });

  it('subject counts only actionable (non-monitoring) registrations', () => {
    const g = group([
      cls({ cleanupStage: 'ready_to_close', daysSinceActivity: 50, dr: { accountName: 'A' } }),
      cls({ cleanupStage: 'monitoring', daysSinceActivity: 5, dr: { accountName: 'B' } }),
    ]);
    expect(buildCleanupEmail(g).subject).toContain('(1 registrations)');
  });
});

describe('buildCleanupEmail styled HTML', () => {
  it('emits styled div blocks with bucket-colored headers and an AE header rule', () => {
    const close = cls({ cleanupStage: 'ready_to_close', daysSinceActivity: 50, dr: { accountName: 'CloseCo', repName: 'Jane Doe' } });
    const { html, body } = buildCleanupEmail(group([close]));
    // Count line is bold with each count colored to its bucket.
    expect(html).toContain('<div style="font-weight:600;margin:0 0 14px">');
    expect(html).toContain('<span style="color:#b91c1c">1 closing</span>');
    // Bucket header carries the closing color.
    expect(html).toContain('<div style="font-weight:600;color:#b91c1c;margin:14px 0 4px">Closing — being closed, no response needed (45+ days)</div>');
    // AE header has the bottom rule and the AE name.
    expect(html).toContain('border-bottom:1px solid #e5e7eb');
    expect(html).toContain('Jane Doe');
    // Deal rows are indented divs (not <br>-joined flat text).
    expect(html).toContain('<div style="margin-left:16px;padding:1px 0">');
    // Plain body still breaks up with a blank line before the AE header.
    expect(body).toContain('\n\nAE: Jane Doe');
  });
});
