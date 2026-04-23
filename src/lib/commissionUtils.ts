import type {
  CommissionReviewsMap,
  CommissionSettingsMap,
  Opportunity,
  RepCommissionSettings,
} from '@/types/forecast';
import { getDateAtUtcStart, getMonthKey } from '@/types/forecast';
import { normalizeRepName } from '@/lib/repUtils';

export interface DealCommissionInputs {
  dealAmount: number;
  baseRate: number;
  quota: number;
  actualBefore: number;
}

export interface DealCommissionResult {
  maxEligible: number;
  standardPayout: number;
  buckets: {
    inBase: number;
    inTier1: number;
    inTier2: number;
    basePayout: number;
    tier1Payout: number;
    tier2Payout: number;
  };
  preCapTotal: number;
  cappedAmount: number;
  finalPayout: number;
  hitCap: boolean;
  actualAfter: number;
}

export interface CommissionReviewRow {
  opportunityId: string;
  opportunityName: string;
  repName: string;
  repKey: string;
  monthKey: string;
  closeDate: string;
  amount: number;
  expectedCommission: number;
  actualCommission?: number;
  note?: string;
  variance?: number;
  monthlyQuota: number;
  annualVariableComp?: number;
  baseRate: number;
  actualBefore: number;
  actualAfter: number;
  attainmentBeforePct: number;
  attainmentAfterPct: number;
  hitCap: boolean;
  tierLabel: string;
  missingSettings: boolean;
}

export interface CommissionReviewSummary {
  repKey: string;
  repName: string;
  monthKey: string;
  expectedTotal: number;
  actualTotal?: number;
  rowActualTotal: number;
  totalVariance?: number;
  rowVarianceTotal?: number;
  flaggedRows: number;
  missingSettings: boolean;
  dealCount: number;
}

export interface CommissionReviewResult {
  availableMonths: string[];
  selectedMonthRows: CommissionReviewRow[];
  summaries: CommissionReviewSummary[];
}

export function getCommissionReviewKey(repKey: string, monthKey: string): string {
  return `${repKey}__${monthKey}`;
}

export function calculateDealCommission({ dealAmount, baseRate, quota, actualBefore }: DealCommissionInputs): DealCommissionResult {
  const amount = Math.max(0, dealAmount || 0);
  const rate = Math.max(0, baseRate || 0);
  const safeQuota = Math.max(0, quota || 0);
  const startActual = Math.max(0, actualBefore || 0);
  const actualAfter = startActual + amount;
  const tier1Cap = safeQuota * 1.4;

  const standardPayout = amount * rate;
  const inBase = Math.max(0, Math.min(actualAfter, safeQuota) - Math.min(startActual, safeQuota));
  const inTier1 = Math.max(0, Math.min(actualAfter, tier1Cap) - Math.max(startActual, safeQuota));
  const inTier2 = Math.max(0, actualAfter - Math.max(startActual, tier1Cap));

  const basePayout = inBase * rate;
  const tier1Payout = inTier1 * rate * 1.5;
  const tier2Payout = inTier2 * rate * 2;
  const preCapTotal = basePayout + tier1Payout + tier2Payout;
  const maxEligible = amount * 0.5;
  const finalPayout = Math.min(preCapTotal, maxEligible);
  const cappedAmount = Math.max(0, preCapTotal - maxEligible);

  return {
    maxEligible,
    standardPayout,
    buckets: { inBase, inTier1, inTier2, basePayout, tier1Payout, tier2Payout },
    preCapTotal,
    cappedAmount,
    finalPayout,
    hitCap: preCapTotal > maxEligible + 0.005,
    actualAfter,
  };
}

function sortByCloseDate(a: Opportunity, b: Opportunity): number {
  const dateDiff = getDateAtUtcStart(a.closeDate).getTime() - getDateAtUtcStart(b.closeDate).getTime();
  if (dateDiff !== 0) return dateDiff;
  return a.name.localeCompare(b.name);
}

function getTierLabel(result: DealCommissionResult): string {
  const labels: string[] = [];
  if (result.buckets.inBase > 0) labels.push('Base');
  if (result.buckets.inTier1 > 0) labels.push('Tier 1');
  if (result.buckets.inTier2 > 0) labels.push('Tier 2');
  return labels.length ? labels.join(' + ') : 'No payout';
}

function getSafeSettings(settings?: RepCommissionSettings): RepCommissionSettings {
  const monthlyQuota = Math.max(0, settings?.monthlyQuota || 0);
  const annualVariableComp = settings?.annualVariableComp === undefined ? undefined : Math.max(0, settings.annualVariableComp || 0);
  const derivedBaseRate = annualVariableComp !== undefined && monthlyQuota > 0
    ? annualVariableComp / (monthlyQuota * 12)
    : undefined;

  return {
    monthlyQuota,
    annualVariableComp,
    baseRate: Math.max(0, derivedBaseRate ?? settings?.baseRate || 0),
  };
}

export function buildCommissionReview(
  opportunities: Opportunity[],
  commissionSettings: CommissionSettingsMap,
  commissionReviews: CommissionReviewsMap,
  selectedMonth?: string,
  selectedRepKey?: string,
  anomaliesOnly = false,
): CommissionReviewResult {
  const closedWon = opportunities
    .filter(opportunity => opportunity.classification === 'closed_won' && opportunity.classification !== 'omitted')
    .sort(sortByCloseDate);

  const availableMonths = Array.from(new Set(closedWon.map(opportunity => getMonthKey(opportunity.closeDate)))).sort((a, b) => b.localeCompare(a));
  const activeMonth = selectedMonth && availableMonths.includes(selectedMonth) ? selectedMonth : availableMonths[0];

  const groupActuals = new Map<string, number>();
  const allRows: CommissionReviewRow[] = [];

  const grouped = new Map<string, Opportunity[]>();
  for (const opportunity of closedWon) {
    const repKey = normalizeRepName(opportunity.repName);
    const monthKey = getMonthKey(opportunity.closeDate);
    const key = getCommissionReviewKey(repKey, monthKey);
    const existing = grouped.get(key) || [];
    existing.push(opportunity);
    grouped.set(key, existing);
  }

  for (const [groupKey, groupOpportunities] of grouped.entries()) {
    groupOpportunities.sort(sortByCloseDate);
    const firstOpportunity = groupOpportunities[0];
    const repKey = normalizeRepName(firstOpportunity.repName);
    const monthKey = getMonthKey(firstOpportunity.closeDate);
    const settings = getSafeSettings(commissionSettings[repKey]);
    const review = commissionReviews[groupKey];
    let actualBefore = 0;

    for (const opportunity of groupOpportunities) {
      const deal = calculateDealCommission({
        dealAmount: opportunity.amount,
        baseRate: settings.baseRate,
        quota: settings.monthlyQuota,
        actualBefore,
      });
      const reviewEntry = review?.opportunities?.[opportunity.id];
      const variance = reviewEntry?.actualCommission === undefined
        ? undefined
        : reviewEntry.actualCommission - deal.finalPayout;

      const row: CommissionReviewRow = {
        opportunityId: opportunity.id,
        opportunityName: opportunity.name,
        repName: opportunity.repName,
        repKey,
        monthKey,
        closeDate: opportunity.closeDate,
        amount: opportunity.amount,
        expectedCommission: deal.finalPayout,
        actualCommission: reviewEntry?.actualCommission,
        note: reviewEntry?.note,
        variance,
        monthlyQuota: settings.monthlyQuota,
          annualVariableComp: settings.annualVariableComp,
        baseRate: settings.baseRate,
        actualBefore,
        actualAfter: deal.actualAfter,
        attainmentBeforePct: settings.monthlyQuota > 0 ? (actualBefore / settings.monthlyQuota) * 100 : 0,
        attainmentAfterPct: settings.monthlyQuota > 0 ? (deal.actualAfter / settings.monthlyQuota) * 100 : 0,
        hitCap: deal.hitCap,
        tierLabel: getTierLabel(deal),
        missingSettings: settings.monthlyQuota <= 0 || settings.baseRate <= 0,
      };

      allRows.push(row);
      actualBefore = deal.actualAfter;
    }

    groupActuals.set(groupKey, review?.actualTotal ?? 0);
  }

  const filteredRows = allRows.filter(row => {
    if (activeMonth && row.monthKey !== activeMonth) return false;
    if (selectedRepKey && selectedRepKey !== 'all' && row.repKey !== selectedRepKey) return false;
    if (anomaliesOnly) return row.variance !== undefined && Math.abs(row.variance) > 0.005;
    return true;
  });

  const summaryMap = new Map<string, CommissionReviewSummary>();
  for (const row of filteredRows) {
    const key = getCommissionReviewKey(row.repKey, row.monthKey);
    const existing = summaryMap.get(key) || {
      repKey: row.repKey,
      repName: row.repName,
      monthKey: row.monthKey,
      expectedTotal: 0,
      actualTotal: commissionReviews[key]?.actualTotal,
      rowActualTotal: 0,
      totalVariance: commissionReviews[key]?.actualTotal === undefined ? undefined : commissionReviews[key].actualTotal! - 0,
      rowVarianceTotal: 0,
      flaggedRows: 0,
      missingSettings: false,
      dealCount: 0,
    };

    existing.expectedTotal += row.expectedCommission;
    existing.rowActualTotal += row.actualCommission ?? 0;
    existing.rowVarianceTotal = (existing.rowVarianceTotal || 0) + (row.variance ?? 0);
    existing.flaggedRows += row.variance !== undefined && Math.abs(row.variance) > 0.005 ? 1 : 0;
    existing.missingSettings = existing.missingSettings || row.missingSettings;
    existing.dealCount += 1;
    existing.totalVariance = existing.actualTotal === undefined ? undefined : existing.actualTotal - existing.expectedTotal;

    summaryMap.set(key, existing);
  }

  return {
    availableMonths,
    selectedMonthRows: filteredRows,
    summaries: Array.from(summaryMap.values()).sort((a, b) => a.repName.localeCompare(b.repName)),
  };
}
