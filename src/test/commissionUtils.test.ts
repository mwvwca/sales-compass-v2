import { describe, expect, it } from 'vitest';
import type { CommissionReviewsMap, CommissionSettingsMap, Opportunity } from '@/types/forecast';
import { buildCommissionReview, calculateDealCommission } from '@/lib/commissionUtils';

const opportunities: Opportunity[] = [
  {
    id: 'opp-1',
    name: 'Deal One',
    repId: 'rep-1',
    repName: 'Jane Smith',
    amount: 500,
    closeDate: '2026-05-03T00:00:00.000Z',
    stage: 'Closed Won',
    classification: 'closed_won',
    probability: 100,
    importDate: '2026-05-03T00:00:00.000Z',
  },
  {
    id: 'opp-2',
    name: 'Deal Two',
    repId: 'rep-1',
    repName: '  jane   smith ',
    amount: 700,
    closeDate: '2026-05-15T00:00:00.000Z',
    stage: 'Closed Won',
    classification: 'closed_won',
    probability: 100,
    importDate: '2026-05-15T00:00:00.000Z',
  },
  {
    id: 'opp-3',
    name: 'Lost Deal',
    repId: 'rep-1',
    repName: 'Jane Smith',
    amount: 900,
    closeDate: '2026-05-22T00:00:00.000Z',
    stage: 'Closed Lost',
    classification: 'lost',
    probability: 0,
    importDate: '2026-05-22T00:00:00.000Z',
  },
  {
    id: 'opp-4',
    name: 'Omitted Won Deal',
    repId: 'rep-1',
    repName: 'Jane Smith',
    amount: 1000,
    closeDate: '2026-05-25T00:00:00.000Z',
    stage: 'Closed Won',
    classification: 'omitted',
    probability: 100,
    importDate: '2026-05-25T00:00:00.000Z',
  },
];

const commissionSettings: CommissionSettingsMap = {
  'jane smith': {
    monthlyQuota: 1000,
    annualVariableComp: 1200,
  },
};

const commissionReviews: CommissionReviewsMap = {
  'jane smith__2026-05': {
    repKey: 'jane smith',
    repName: 'Jane Smith',
    monthKey: '2026-05',
    actualTotal: 135,
    opportunities: {
      'opp-1': {
        actualCommission: 50,
        note: 'Matches statement',
      },
      'opp-2': {
        actualCommission: 85,
        note: 'Investigate short-pay',
      },
    },
  },
};

describe('commissionUtils', () => {
  it('applies tiered deal math with caps', () => {
    const result = calculateDealCommission({ dealAmount: 700, baseRate: 0.1, quota: 1000, actualBefore: 500 });

    expect(result.buckets.inBase).toBe(500);
    expect(result.buckets.inTier1).toBe(200);
    expect(result.finalPayout).toBe(80);
    expect(result.hitCap).toBe(false);
  });

  it('derives base rate from annual variable comp when provided', () => {
    const review = buildCommissionReview(opportunities, commissionSettings, commissionReviews, '2026-05');

    expect(review.selectedMonthRows[0].baseRate).toBeCloseTo(0.1);
  });

  it('builds monthly review rows from closed won deals only and normalizes rep names', () => {
    const review = buildCommissionReview(opportunities, commissionSettings, commissionReviews, '2026-05');

    expect(review.availableMonths).toEqual(['2026-05']);
    expect(review.selectedMonthRows).toHaveLength(2);
    expect(review.selectedMonthRows.map(row => row.opportunityId)).toEqual(['opp-1', 'opp-2']);
    expect(review.selectedMonthRows[1].repKey).toBe('jane smith');
    expect(review.selectedMonthRows[1].expectedCommission).toBe(80);
    expect(review.selectedMonthRows[1].variance).toBeCloseTo(5);
    expect(review.summaries[0].expectedTotal).toBe(130);
    expect(review.summaries[0].actualTotal).toBe(135);
    expect(review.summaries[0].flaggedRows).toBe(1);
    expect(review.selectedMonthRows.every(row => row.opportunityId !== 'opp-4')).toBe(true);
    expect(review.selectedMonthRows[1].actualBefore).toBe(500);
    expect(review.selectedMonthRows[1].actualAfter).toBe(1200);
  });
});
