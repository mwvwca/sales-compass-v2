import type { Opportunity } from '@/types/forecast';
import { normalizeRepName } from '@/lib/repUtils';

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
