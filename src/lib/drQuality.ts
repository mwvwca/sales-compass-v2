import type { Opportunity } from '@/types/forecast';
import { normalizeRepName } from '@/lib/repUtils';

// ============================================================================
// DR Quality Scoring Engine
// ============================================================================

export type DrTier = 'Strong' | 'Marginal' | 'Weak' | 'Disqualified';

export interface DrScoreResult {
  opportunityId: string;
  score: number;
  tier: DrTier;
  disqualified: boolean;
  disqualifyReason: string;
  subscores: {
    stageVelocity: number;
    closeDateIntegrity: number;
    amountCredibility: number;
    forecastCredibility: number;
    accountStacking: number;
    closeDateRealism: number;
  };
}

const DISQUALIFY_STAGES = new Set([
  'closed lost', 'omitted', 'unqualified', 'rejected',
]);

const SCORE_WEIGHTS = {
  stageVelocity: 0.25,
  closeDateIntegrity: 0.20,
  amountCredibility: 0.15,
  forecastCredibility: 0.15,
  accountStacking: 0.15,
  closeDateRealism: 0.10,
};

function daysUntil(dateStr: string | undefined): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  return Math.floor((d.getTime() - now.getTime()) / 86400000);
}

function stageVelocityScore(days: number | null): number {
  if (days === null) return 20;
  if (days < 0) return 0;
  if (days <= 14) return 60;
  if (days <= 30) return 80;
  if (days <= 90) return 100;
  return 90;
}

function closeDateIntegrityScore(days: number | null, isOpen: boolean): number {
  if (days === null) return 10;
  if (days < 0 && isOpen) return 0;
  if (days > 365) return 60;
  return 100;
}

function amountCredibilityScore(amount: number): number {
  if (!amount || amount <= 0) return 0;
  if (amount < 100) return 20;
  if (amount <= 1000 && amount % 500 === 0) return 40;
  if (amount > 1000 && amount % 1000 === 0) return 70;
  return 100;
}

function forecastCredibilityScore(o: Opportunity): number {
  switch (o.classification) {
    case 'commit': return 100;
    case 'closed_won': return 100;
    case 'upside': return 70;
    case 'unclassified': return 50;
    case 'omitted': return 0;
    case 'lost': return 0;
    default: return 40;
  }
}

function accountStackingScore(openCount: number, hasAccount: boolean): number {
  if (!hasAccount) return 50;
  if (openCount <= 1) return 100;
  if (openCount === 2) return 75;
  if (openCount <= 4) return 40;
  return 0;
}

function closeDateRealismScore(days: number | null, isOpen: boolean): number {
  if (days === null) return 100;
  if (days < 0 && isOpen) return 0;
  return 100;
}

function tierFor(score: number): DrTier {
  if (score >= 75) return 'Strong';
  if (score >= 50) return 'Marginal';
  return 'Weak';
}

export function computeDrScores(opps: Opportunity[]): Map<string, DrScoreResult> {
  // open opps per account
  const openByAccount = new Map<string, number>();
  for (const o of opps) {
    const key = (o.accountName || '').trim().toLowerCase();
    if (!key) continue;
    if (o.classification === 'closed_won' || o.classification === 'lost' || o.classification === 'omitted') continue;
    openByAccount.set(key, (openByAccount.get(key) || 0) + 1);
  }

  const out = new Map<string, DrScoreResult>();
  for (const o of opps) {
    const stageLower = (o.stage || '').toLowerCase().trim();
    const isOpen = o.classification !== 'closed_won' && o.classification !== 'lost' && o.classification !== 'omitted';

    let dqReason = '';
    if (!o.amount || o.amount <= 0) dqReason = 'Zero or missing amount';
    else if (DISQUALIFY_STAGES.has(stageLower) || o.classification === 'lost' || o.classification === 'omitted') {
      dqReason = `Stage: ${o.stage || o.classification}`;
    } else if (typeof o.probability === 'number' && o.probability > 0 && o.probability < 25) {
      dqReason = `Probability ${o.probability}% < 25%`;
    }

    if (dqReason) {
      out.set(o.id, {
        opportunityId: o.id,
        score: 0,
        tier: 'Disqualified',
        disqualified: true,
        disqualifyReason: dqReason,
        subscores: { stageVelocity: 0, closeDateIntegrity: 0, amountCredibility: 0, forecastCredibility: 0, accountStacking: 0, closeDateRealism: 0 },
      });
      continue;
    }

    const days = daysUntil(o.closeDate);
    const acctKey = (o.accountName || '').trim().toLowerCase();
    const openCount = acctKey ? (openByAccount.get(acctKey) || 1) : 0;

    const sub = {
      stageVelocity: stageVelocityScore(days),
      closeDateIntegrity: closeDateIntegrityScore(days, isOpen),
      amountCredibility: amountCredibilityScore(o.amount),
      forecastCredibility: forecastCredibilityScore(o),
      accountStacking: accountStackingScore(openCount, !!acctKey),
      closeDateRealism: closeDateRealismScore(days, isOpen),
    };

    const weighted = Math.round(
      sub.stageVelocity * SCORE_WEIGHTS.stageVelocity +
      sub.closeDateIntegrity * SCORE_WEIGHTS.closeDateIntegrity +
      sub.amountCredibility * SCORE_WEIGHTS.amountCredibility +
      sub.forecastCredibility * SCORE_WEIGHTS.forecastCredibility +
      sub.accountStacking * SCORE_WEIGHTS.accountStacking +
      sub.closeDateRealism * SCORE_WEIGHTS.closeDateRealism
    );

    out.set(o.id, {
      opportunityId: o.id,
      score: weighted,
      tier: tierFor(weighted),
      disqualified: false,
      disqualifyReason: '',
      subscores: sub,
    });
  }
  return out;
}



/**
 * DR Quality analytics — quantifies multi-product concentration on the same
 * account and the win-rate delta between single-product and multi-product
 * accounts. We deliberately do NOT distinguish "primary" vs "tag-along" DRs
 * because there is no consistent signal in the data; instead we measure
 * the effect of stacking multiple opps on a single account.
 *
 * "Open" = not closed_won, not lost. Win rate uses (won) / (won + lost).
 */

export interface CohortStats {
  count: number;
  amount: number;
  won: number;
  lost: number;
  open: number;
  winRate: number; // 0..1, NaN if no decided deals
  avgAmount: number;
}

export interface AccountBucket {
  accountKey: string;
  accountLabel: string;
  oppCount: number;
  productCount: number;
  totalAmount: number;
  opps: Opportunity[];
}

export interface PerRepHygiene {
  repKey: string;
  repName: string;
  totalOpps: number;
  multiProductOpps: number;
  multiProductPct: number;
  singleProduct: CohortStats;
  multiProduct: CohortStats;
  oppsPerAccount: number;
}

export interface DrQualityResult {
  totalOpps: number;
  oppsWithAccount: number;
  oppsWithProduct: number;
  accountCoverage: number; // 0..1
  productCoverage: number; // 0..1

  totalAccounts: number;
  multiProductAccounts: number;
  multiProductAccountPct: number;
  multiProductOpps: number;
  multiProductOppPct: number;

  singleProductCohort: CohortStats;
  multiProductCohort: CohortStats;

  reportedPipeline: CohortStats;
  strippedPipeline: CohortStats; // after removing opps on accounts with >= stripThreshold open opps
  strippedRemovedCount: number;
  strippedRemovedAmount: number;

  perRep: PerRepHygiene[];
  topStackedAccounts: AccountBucket[]; // top 10 by oppCount
}

const isWon = (o: Opportunity) => o.classification === 'closed_won';
const isLost = (o: Opportunity) => o.classification === 'lost';
const isDecided = (o: Opportunity) => isWon(o) || isLost(o);
const isOpen = (o: Opportunity) => !isWon(o) && !isLost(o) && o.classification !== 'omitted';

function cohortStats(opps: Opportunity[]): CohortStats {
  const won = opps.filter(isWon).length;
  const lost = opps.filter(isLost).length;
  const open = opps.filter(isOpen).length;
  const decided = won + lost;
  const amount = opps.reduce((s, o) => s + (o.amount || 0), 0);
  return {
    count: opps.length,
    amount,
    won,
    lost,
    open,
    winRate: decided > 0 ? won / decided : NaN,
    avgAmount: opps.length > 0 ? amount / opps.length : 0,
  };
}

function accountKeyFor(o: Opportunity): string | null {
  const a = (o.accountName || '').trim().toLowerCase();
  return a ? a : null;
}

function productKeyFor(o: Opportunity): string | null {
  const p = (o.productName || '').trim().toLowerCase();
  return p ? p : null;
}

export interface DrQualityOptions {
  /** An account is "stacked" if it has >= this many open opps. Default 3. */
  stripThreshold: number;
  /** Restrict to opps where rep matches one of these names (normalized). Empty = all reps. */
  repFilter?: string[];
}

export function computeDrQuality(
  allOpps: Opportunity[],
  options: DrQualityOptions,
): DrQualityResult {
  const repFilterSet = options.repFilter && options.repFilter.length > 0
    ? new Set(options.repFilter.map(normalizeRepName))
    : null;

  const opps = repFilterSet
    ? allOpps.filter(o => repFilterSet.has(normalizeRepName(o.repName)))
    : allOpps.slice();

  const totalOpps = opps.length;
  const oppsWithAccount = opps.filter(o => accountKeyFor(o)).length;
  const oppsWithProduct = opps.filter(o => productKeyFor(o)).length;

  // Group by account
  const byAccount = new Map<string, AccountBucket>();
  for (const o of opps) {
    const key = accountKeyFor(o);
    if (!key) continue;
    const bucket = byAccount.get(key) || {
      accountKey: key,
      accountLabel: o.accountName || key,
      oppCount: 0,
      productCount: 0,
      totalAmount: 0,
      opps: [],
    };
    bucket.opps.push(o);
    bucket.oppCount = bucket.opps.length;
    bucket.totalAmount += o.amount || 0;
    const distinctProducts = new Set(bucket.opps.map(productKeyFor).filter(Boolean) as string[]);
    bucket.productCount = distinctProducts.size;
    byAccount.set(key, bucket);
  }

  const accounts = Array.from(byAccount.values());
  const multiProductAccounts = accounts.filter(a => a.productCount >= 2 || a.oppCount >= 2);
  const multiProductOppIds = new Set<string>();
  for (const a of multiProductAccounts) {
    for (const o of a.opps) multiProductOppIds.add(o.id);
  }

  const singleProductOpps = opps.filter(o => {
    const k = accountKeyFor(o);
    if (!k) return false;
    return !multiProductOppIds.has(o.id);
  });
  const multiProductOppsList = opps.filter(o => multiProductOppIds.has(o.id));

  // Stripped pipeline: remove opps on accounts that have >= stripThreshold open opps
  const stackedAccountKeys = new Set(
    accounts
      .filter(a => a.opps.filter(isOpen).length >= options.stripThreshold)
      .map(a => a.accountKey),
  );
  const stripped = opps.filter(o => {
    const k = accountKeyFor(o);
    if (!k) return true;
    return !stackedAccountKeys.has(k);
  });
  const removedOpps = opps.filter(o => {
    const k = accountKeyFor(o);
    return k ? stackedAccountKeys.has(k) : false;
  });

  // Per-rep hygiene
  const repMap = new Map<string, { repName: string; opps: Opportunity[] }>();
  for (const o of opps) {
    const key = normalizeRepName(o.repName);
    if (!key) continue;
    const entry = repMap.get(key) || { repName: o.repName, opps: [] };
    entry.opps.push(o);
    repMap.set(key, entry);
  }
  const perRep: PerRepHygiene[] = Array.from(repMap.entries()).map(([repKey, { repName, opps: repOpps }]) => {
    const repAccountKeys = new Set(repOpps.map(accountKeyFor).filter(Boolean) as string[]);
    const repMulti = repOpps.filter(o => multiProductOppIds.has(o.id));
    const repSingle = repOpps.filter(o => {
      const k = accountKeyFor(o);
      return k && !multiProductOppIds.has(o.id);
    });
    return {
      repKey,
      repName,
      totalOpps: repOpps.length,
      multiProductOpps: repMulti.length,
      multiProductPct: repOpps.length > 0 ? repMulti.length / repOpps.length : 0,
      singleProduct: cohortStats(repSingle),
      multiProduct: cohortStats(repMulti),
      oppsPerAccount: repAccountKeys.size > 0 ? repOpps.length / repAccountKeys.size : 0,
    };
  }).sort((a, b) => b.multiProductPct - a.multiProductPct);

  const topStackedAccounts = accounts
    .slice()
    .sort((a, b) => b.oppCount - a.oppCount)
    .slice(0, 10);

  return {
    totalOpps,
    oppsWithAccount,
    oppsWithProduct,
    accountCoverage: totalOpps > 0 ? oppsWithAccount / totalOpps : 0,
    productCoverage: totalOpps > 0 ? oppsWithProduct / totalOpps : 0,

    totalAccounts: accounts.length,
    multiProductAccounts: multiProductAccounts.length,
    multiProductAccountPct: accounts.length > 0 ? multiProductAccounts.length / accounts.length : 0,
    multiProductOpps: multiProductOppsList.length,
    multiProductOppPct: opps.length > 0 ? multiProductOppsList.length / opps.length : 0,

    singleProductCohort: cohortStats(singleProductOpps),
    multiProductCohort: cohortStats(multiProductOppsList),

    reportedPipeline: cohortStats(opps),
    strippedPipeline: cohortStats(stripped),
    strippedRemovedCount: removedOpps.length,
    strippedRemovedAmount: removedOpps.reduce((s, o) => s + (o.amount || 0), 0),

    perRep,
    topStackedAccounts,
  };
}
