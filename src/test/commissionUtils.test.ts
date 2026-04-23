import { describe, expect, it } from 'vitest';
import type { CommissionReviewsMap, CommissionSettingsMap, Opportunity } from '@/types/forecast';
import {
  buildCommissionReview,
  calculateDealCommission,
  getLtcMultiplier,
  getQuarterlyAccelerator,
} from '@/lib/commissionUtils';
import { resolveImportedClassification } from '@/lib/forecastClassification';

const opportunities: Opportunity[] = [
  {
    id: 'opp-1',
    name: 'Deal One',
    repId: 'rep-1',
    repName: 'Jane Smith',
    amount: 60000,
    closeDate: '2026-05-03T00:00:00.000Z',
    stage: 'Closed Won',
    classification: 'closed_won',
    probability: 100,
    importDate: '2026-05-03T00:00:00.000Z',
    commissionMrr: 4000,
  },
  {
    id: 'opp-2',
    name: 'Deal Reg - NdeR - BW Cyber - MDR',
    repId: 'rep-1',
    repName: '  jane   smith ',
    amount: 100000,
    closeDate: '2026-05-15T00:00:00.000Z',
    stage: 'Closed Won',
    classification: 'closed_won',
    probability: 100,
    importDate: '2026-05-15T00:00:00.000Z',
    commissionMrr: 4305.4,
    commissionTermYears: 1,
    commissionPaymentType: 'annual',
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
  {
    id: 'opp-5',
    name: 'Migrated Omitted Won Deal',
    repId: 'rep-1',
    repName: 'Jane Smith',
    amount: 1200,
    closeDate: '2026-05-26T00:00:00.000Z',
    stage: 'Closed Won',
    classification: 'closed_won',
    previousClassification: 'omitted',
    probability: 100,
    importDate: '2026-05-26T00:00:00.000Z',
  },
  {
    id: 'opp-6',
    name: 'Two Year Upfront Deal',
    repId: 'rep-1',
    repName: 'Jane Smith',
    amount: 180000,
    closeDate: '2026-05-28T00:00:00.000Z',
    stage: 'Closed Won',
    classification: 'closed_won',
    probability: 100,
    importDate: '2026-05-28T00:00:00.000Z',
    commissionMrr: 5000,
    commissionTermYears: 2,
    commissionPaymentType: 'upfront',
    commissionSpiff: 250,
  },
];

const commissionSettings: CommissionSettingsMap = {
  'jane smith': {
    monthlyQuota: 5000,
    annualVariableComp: 9000,
    priorQuarterPayout: 0,
  },
};

const commissionReviews: CommissionReviewsMap = {
  'jane smith__2026-05': {
    repKey: 'jane smith',
    repName: 'Jane Smith',
    monthKey: '2026-05',
    actualTotal: 3000,
    opportunities: {
      'opp-1': {
        actualCommission: 600,
        note: 'Matches statement',
      },
      'opp-2': {
        actualCommission: 645.81,
        note: 'Calculator reference',
      },
    },
  },
};

const timLakeOpportunity: Opportunity[] = [
  {
    id: 'tim-1',
    name: 'Deal Reg - NdeR - BW Cyber - MDR',
    repId: 'rep-tim',
    repName: 'Tim Lake',
    amount: 51664.8,
    closeDate: '2026-05-15T00:00:00.000Z',
    stage: 'Closed Won',
    classification: 'closed_won',
    probability: 100,
    importDate: '2026-05-15T00:00:00.000Z',
    commissionMrr: 4305.4,
    commissionTermYears: 1,
    commissionPaymentType: 'annual',
  },
];

const timLakeSettings: CommissionSettingsMap = {
  'tim lake': {
    monthlyQuota: 5000,
    annualVariableComp: 750,
    priorQuarterPayout: 0,
  },
};

describe('commissionUtils', () => {
  it('applies source payout math with LTC, accelerator, cap, and spiff', () => {
    const result = calculateDealCommission({
      annualAcv: 60000,
      baseRate: 0.15,
      quarterlyQuota: 15000,
      quarterBookedBefore: 17000,
      termYears: 2,
      paymentType: 'upfront',
      spiff: 250,
    });

    expect(result.startingAttainmentPct).toBeCloseTo(113.33, 2);
    expect(result.ltcMultiplier).toBe(1.4);
    expect(result.accelerator).toBe(1.5);
    expect(result.baseCommission).toBe(9000);
    expect(result.multipliedCommission).toBe(18900);
    expect(result.finalPayout).toBe(19150);
    expect(result.hitCap).toBe(false);
  });

  it('matches the calculator example for the Tim Lake deal', () => {
    const review = buildCommissionReview(timLakeOpportunity, timLakeSettings, {}, '2026-05');
    expect(review.selectedMonthRows[0].expectedCommission).toBeCloseTo(645.81, 2);
    expect(review.selectedMonthRows[0].accelerator).toBe(1);
    expect(review.selectedMonthRows[0].ltcMultiplier).toBe(1);
  });

  it('exposes source multiplier helpers', () => {
    expect(getLtcMultiplier(1, 'annual')).toBe(1);
    expect(getLtcMultiplier(2, 'annual')).toBe(1.3);
    expect(getLtcMultiplier(2, 'upfront')).toBe(1.4);
    expect(getLtcMultiplier(4, 'annual')).toBe(1.5);
    expect(getLtcMultiplier(4, 'upfront')).toBe(1.6);
    expect(getQuarterlyAccelerator(80)).toBe(1);
    expect(getQuarterlyAccelerator(100)).toBe(1.5);
    expect(getQuarterlyAccelerator(150)).toBe(2);
  });

  it('builds monthly rows using quarter-aware context and excludes omitted deals', () => {
    const review = buildCommissionReview(opportunities, commissionSettings, commissionReviews, '2026-05');

    expect(review.availableMonths).toEqual(['2026-05']);
    expect(review.selectedMonthRows.map(row => row.opportunityId)).toEqual(['opp-1', 'opp-2', 'opp-6']);
    expect(review.selectedMonthRows[1].repKey).toBe('jane smith');
    expect(review.selectedMonthRows[1].quarterBookedBefore).toBeCloseTo(48000, 2);
    expect(review.selectedMonthRows[1].quarterBookedAfter).toBeCloseTo(99664.8, 2);
    expect(review.selectedMonthRows[1].accelerator).toBe(2);
    expect(review.selectedMonthRows.every(row => row.opportunityId !== 'opp-4')).toBe(true);
    expect(review.selectedMonthRows.every(row => row.opportunityId !== 'opp-5')).toBe(true);
    expect(review.summaries[0].expectedTotal).toBeCloseTo(48149.44, 2);
  });

  it('keeps closed won, lost, and omitted classifications sticky during imports', () => {
    expect(resolveImportedClassification('omitted', 'closed_won')).toBe('omitted');
    expect(resolveImportedClassification('closed_won', 'commit')).toBe('closed_won');
    expect(resolveImportedClassification('lost', 'upside')).toBe('lost');
    expect(resolveImportedClassification('closed_won', 'omitted')).toBe('omitted');
  });
});
