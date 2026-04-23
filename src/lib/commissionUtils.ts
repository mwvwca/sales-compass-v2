import type {
  CommissionReviewsMap,
  CommissionSettingsMap,
  Opportunity,
  RepCommissionSettings,
} from '@/types/forecast';
import { getDateAtUtcStart, getMonthKey, getQuarter } from '@/types/forecast';
import { normalizeRepName } from '@/lib/repUtils';

export interface DealCommissionInputs {
  annualAcv: number;
  baseRate: number;
  quarterlyQuota: number;
  quarterBookedBefore: number;
  termYears?: number;
  paymentType?: 'annual' | 'upfront';
  spiff?: number;
}

export interface DealCommissionResult {
  annualAcv: number;
  baseRate: number;
  quarterlyQuota: number;
  quarterBookedBefore: number;
  quarterBookedAfter: number;
  startingAttainmentPct: number;
  endingAttainmentPct: number;
  accelerator: number;
  ltcMultiplier: number;
  baseCommission: number;
  multipliedCommission: number;
  capAmount: number;
  cappedCommission: number;
  finalPayout: number;
  spiff: number;
  hitCap: boolean;
}

export interface CommissionReviewRow {
  opportunityId: string;
  opportunityName: string;
  repName: string;
  repKey: string;
  monthKey: string;
  quarterKey: string;
  closeDate: string;
  amount: number;
  expectedCommission: number;
  actualCommission?: number;
  note?: string;
  variance?: number;
  monthlyQuota: number;
  quarterlyQuota: number;
  annualVariableComp?: number;
  priorQuarterPayout: number;
  baseRate: number;
  quarterBookedBefore: number;
  quarterBookedAfter: number;
  startingAttainmentPct: number;
  endingAttainmentPct: number;
  hitCap: boolean;
  missingSettings: boolean;
  annualAcv: number;
  commissionMrr?: number;
  commissionTermYears: number;
  commissionPaymentType: 'annual' | 'upfront';
  commissionSpiff: number;
  commissionNotes?: string;
  ltcMultiplier: number;
  accelerator: number;
  acceleratorLabel: string;
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

function getQuarterlyQuota(monthlyQuota: number): number {
  return Math.max(0, monthlyQuota || 0) * 3;
}

export function getLtcMultiplier(termYears = 1, paymentType: 'annual' | 'upfront' = 'annual'): number {
  if (termYears <= 1) return 1;
  if (termYears === 2) return paymentType === 'upfront' ? 1.4 : 1.3;
  return paymentType === 'upfront' ? 1.6 : 1.5;
}

export function getQuarterlyAccelerator(startingAttainmentPct: number): number {
  if (startingAttainmentPct > 140) return 2;
  if (startingAttainmentPct >= 100) return 1.5;
  return 1;
}

export function getAcceleratorLabel(multiplier: number): string {
  if (multiplier >= 2) return '140%+ band';
  if (multiplier >= 1.5) return '100–140% band';
  return '<100% band';
}

export function calculateDealCommission({
  annualAcv,
  baseRate,
  quarterlyQuota,
  quarterBookedBefore,
  termYears = 1,
  paymentType = 'annual',
  spiff = 0,
}: DealCommissionInputs): DealCommissionResult {
  const safeAnnualAcv = Math.max(0, annualAcv || 0);
  const safeBaseRate = Math.max(0, baseRate || 0);
  const safeQuarterlyQuota = Math.max(0, quarterlyQuota || 0);
  const safeQuarterBookedBefore = Math.max(0, quarterBookedBefore || 0);
  const safeSpiff = Math.max(0, spiff || 0);

  const startingAttainmentPct = safeQuarterlyQuota > 0 ? (safeQuarterBookedBefore / safeQuarterlyQuota) * 100 : 0;
  const accelerator = getQuarterlyAccelerator(startingAttainmentPct);
  const ltcMultiplier = getLtcMultiplier(termYears, paymentType);
  const baseCommission = safeAnnualAcv * safeBaseRate;
  const multipliedCommission = baseCommission * ltcMultiplier * accelerator;
  const capAmount = safeAnnualAcv * 0.5;
  const cappedCommission = Math.min(multipliedCommission, capAmount);
  const finalPayout = cappedCommission + safeSpiff;
  const quarterBookedAfter = safeQuarterBookedBefore + safeAnnualAcv;
  const endingAttainmentPct = safeQuarterlyQuota > 0 ? (quarterBookedAfter / safeQuarterlyQuota) * 100 : 0;

  return {
    annualAcv: safeAnnualAcv,
    baseRate: safeBaseRate,
    quarterlyQuota: safeQuarterlyQuota,
    quarterBookedBefore: safeQuarterBookedBefore,
    quarterBookedAfter,
    startingAttainmentPct,
    endingAttainmentPct,
    accelerator,
    ltcMultiplier,
    baseCommission,
    multipliedCommission,
    capAmount,
    cappedCommission,
    finalPayout,
    spiff: safeSpiff,
    hitCap: multipliedCommission > capAmount + 0.005,
  };
}

function sortByCloseDate(a: Opportunity, b: Opportunity): number {
  const dateDiff = getDateAtUtcStart(a.closeDate).getTime() - getDateAtUtcStart(b.closeDate).getTime();
  if (dateDiff !== 0) return dateDiff;
  return a.name.localeCompare(b.name);
}

function normalizeClassification(value?: Opportunity['classification']): Opportunity['classification'] | '' {
  if (!value) return '';
  return value.toLowerCase().trim().replace(/[\s-]+/g, '_') as Opportunity['classification'];
}

function isCommissionEligible(opportunity: Opportunity): boolean {
  const classification = normalizeClassification(opportunity.classification);
  const previousClassification = normalizeClassification(opportunity.previousClassification);
  return classification === 'closed_won' && previousClassification !== 'omitted';
}

function getSafeSettings(settings?: RepCommissionSettings): Required<Pick<RepCommissionSettings, 'monthlyQuota' | 'priorQuarterPayout' | 'baseRate'>> & Pick<RepCommissionSettings, 'annualVariableComp'> {
  const monthlyQuota = Math.max(0, settings?.monthlyQuota || 0);
  const annualVariableComp = settings?.annualVariableComp === undefined ? undefined : Math.max(0, settings.annualVariableComp || 0);
  const derivedBaseRate = annualVariableComp !== undefined && monthlyQuota > 0
    ? annualVariableComp / (monthlyQuota * 12)
    : undefined;

  return {
    monthlyQuota,
    annualVariableComp,
    priorQuarterPayout: Math.max(0, settings?.priorQuarterPayout || 0),
    baseRate: Math.max(0, derivedBaseRate ?? settings?.baseRate ?? 0),
  };
}

function getAnnualAcv(opportunity: Opportunity): number {
  if ((opportunity.commissionMrr || 0) > 0) return Math.max(0, opportunity.commissionMrr || 0) * 12;
  return Math.max(0, opportunity.amount || 0);
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
    .filter(isCommissionEligible)
    .sort(sortByCloseDate);

  const availableMonths = Array.from(new Set(closedWon.map(opportunity => getMonthKey(opportunity.closeDate)))).sort((a, b) => b.localeCompare(a));
  const activeMonth = selectedMonth && availableMonths.includes(selectedMonth) ? selectedMonth : availableMonths[0];
  const allRows: CommissionReviewRow[] = [];

  const grouped = new Map<string, Opportunity[]>();
  for (const opportunity of closedWon) {
    const repKey = normalizeRepName(opportunity.repName);
    const quarterKey = getQuarter(opportunity.closeDate);
    const key = `${repKey}__${quarterKey}`;
    const existing = grouped.get(key) || [];
    existing.push(opportunity);
    grouped.set(key, existing);
  }

  for (const groupOpportunities of grouped.values()) {
    groupOpportunities.sort(sortByCloseDate);
    const firstOpportunity = groupOpportunities[0];
    const repKey = normalizeRepName(firstOpportunity.repName);
    const settings = getSafeSettings(commissionSettings[repKey]);
    const quarterlyQuota = getQuarterlyQuota(settings.monthlyQuota);
    let quarterBookedBefore = settings.baseRate > 0 ? settings.priorQuarterPayout / settings.baseRate : 0;

    for (const opportunity of groupOpportunities) {
      const monthKey = getMonthKey(opportunity.closeDate);
      const review = commissionReviews[getCommissionReviewKey(repKey, monthKey)];
      const reviewEntry = review?.opportunities?.[opportunity.id];
      const annualAcv = getAnnualAcv(opportunity);
      const termYears = Math.max(1, Math.round(opportunity.commissionTermYears || 1));
      const paymentType = opportunity.commissionPaymentType || 'annual';
      const spiff = Math.max(0, opportunity.commissionSpiff || 0);
      const deal = calculateDealCommission({
        annualAcv,
        baseRate: settings.baseRate,
        quarterlyQuota,
        quarterBookedBefore,
        termYears,
        paymentType,
        spiff,
      });
      const expectedCommission = deal.finalPayout;
      const variance = reviewEntry?.actualCommission === undefined
        ? undefined
        : reviewEntry.actualCommission - expectedCommission;

      allRows.push({
        opportunityId: opportunity.id,
        opportunityName: opportunity.name,
        repName: opportunity.repName,
        repKey,
        monthKey,
        quarterKey: getQuarter(opportunity.closeDate),
        closeDate: opportunity.closeDate,
        amount: opportunity.amount,
        expectedCommission,
        actualCommission: reviewEntry?.actualCommission,
        note: reviewEntry?.note,
        variance,
        monthlyQuota: settings.monthlyQuota,
        quarterlyQuota,
        annualVariableComp: settings.annualVariableComp,
        priorQuarterPayout: settings.priorQuarterPayout,
        baseRate: settings.baseRate,
        quarterBookedBefore: deal.quarterBookedBefore,
        quarterBookedAfter: deal.quarterBookedAfter,
        startingAttainmentPct: deal.startingAttainmentPct,
        endingAttainmentPct: deal.endingAttainmentPct,
        hitCap: deal.hitCap,
        missingSettings: settings.monthlyQuota <= 0 || settings.baseRate <= 0,
        annualAcv,
        commissionMrr: opportunity.commissionMrr,
        commissionTermYears: termYears,
        commissionPaymentType: paymentType,
        commissionSpiff: spiff,
        commissionNotes: opportunity.commissionNotes,
        ltcMultiplier: deal.ltcMultiplier,
        accelerator: deal.accelerator,
        acceleratorLabel: getAcceleratorLabel(deal.accelerator),
      });

      quarterBookedBefore = deal.quarterBookedAfter;
    }
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
