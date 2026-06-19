import type { DealRegistration, Opportunity } from '@/types/forecast';
import { everReachedSql, currentlySql, daysSinceActivity } from './drSql';

// ---- Amount helpers (shared by AE / CAM / reseller rollups) ----

/** Pipeline DR = SQL'd, amount > 0, still open. */
export function isPipelineDr(d: DealRegistration): boolean {
  return !!d.isSql && (d.amount ?? 0) > 0 &&
    d.status !== 'closed_won' && d.status !== 'closed_lost' &&
    d.status !== 'rejected' && d.status !== 'withdrawn';
}

export function pipelineSum(deals: DealRegistration[]): number {
  return deals.filter(isPipelineDr).reduce((s, d) => s + (d.amount || 0), 0);
}

export function closedWonSum(deals: DealRegistration[], oppMap?: Map<string, Opportunity>): number {
  return deals.filter(d => d.status === 'closed_won').reduce((s, d) => {
    const amt = (d.amount ?? null) !== null && (d.amount ?? 0) > 0
      ? (d.amount as number)
      : (oppMap?.get(d.opportunityId)?.amount ?? 0);
    return s + (amt || 0);
  }, 0);
}

// ---- Cohort (per-rep / per-cam vintage) rows ----

export type CohortRow = {
  quarter: string; total: number; sql: number; closedWon: number;
  cohortRate: number; avgCycle: number | null;
};

export function buildCohortRows(deals: DealRegistration[]): CohortRow[] {
  const byQ = new Map<string, DealRegistration[]>();
  for (const d of deals) {
    if (!d.createdDate) continue;
    // Inline quarter calc to avoid importing — matches getQuarter shape "YYYY-QN"
    const dd = new Date(d.createdDate);
    const y = dd.getUTCFullYear();
    const q = Math.floor(dd.getUTCMonth() / 3) + 1;
    const key = `${y}-Q${q}`;
    const arr = byQ.get(key) || []; arr.push(d); byQ.set(key, arr);
  }
  const rows: CohortRow[] = Array.from(byQ.entries()).map(([quarter, arr]) => {
    const total = arr.length;
    const sql = arr.filter(d => d.isSql || d.sqlDate).length;
    const wonDeals = arr.filter(d => d.status === 'closed_won');
    const closedWon = wonDeals.length;
    const cohortRate = total ? closedWon / total : 0;
    const cycles = wonDeals.map(d => d.cycleDays).filter((n): n is number => typeof n === 'number');
    const avgCycle = cycles.length ? cycles.reduce((s, n) => s + n, 0) / cycles.length : null;
    return { quarter, total, sql, closedWon, cohortRate, avgCycle };
  });
  rows.sort((a, b) => a.quarter.localeCompare(b.quarter));
  return rows;
}

// ---- AE accountability rows ----

export type AeRow = {
  rep: string; assigned: number; rejected: number; sqls: number; sqlRate: number;
  stale: number; noActivity: number; unworked: number; unworkedPct: number; avgAge: number;
  converted: number; closedWon: number; convRate: number;
  cohortRate: number; avgCycle: number | null;
  pipelineAmount: number; closedWonAmount: number;
  rejectedByCam: Map<string, { count: number; products: string[] }>;
  cohort: CohortRow[];
};

export interface AeAccountabilityOpts {
  /** opportunity id → opp, for closed-won amount fallback. */
  oppMap?: Map<string, Opportunity>;
  /** When false, rows for inactive reps are dropped. Defaults to true (keep all). */
  showInactiveReps?: boolean;
  /** Rep names considered inactive (filtered when showInactiveReps is false). */
  inactiveRepNameSet?: Set<string>;
  /** Override "now" for deterministic tests; defaults to new Date(). */
  today?: Date;
}

/**
 * Per-AE accountability rollup over a set of deal registrations (already scoped
 * by the caller). Pure: identical output for identical input + opts.
 */
export function computeAeRows(dealRegistrations: DealRegistration[], opts: AeAccountabilityOpts = {}): AeRow[] {
  const { oppMap, showInactiveReps = true, inactiveRepNameSet = new Set<string>(), today = new Date() } = opts;

  const byRep = new Map<string, DealRegistration[]>();
  for (const d of dealRegistrations) {
    const k = d.repName || '(unassigned)';
    const arr = byRep.get(k) || [];
    arr.push(d);
    byRep.set(k, arr);
  }
  const rows: AeRow[] = Array.from(byRep.entries()).map(([rep, deals]) => {
    const assigned = deals.length;
    const rejected = deals.filter(d => d.status === 'rejected').length;
    const nonRejected = deals.filter(d => d.status !== 'rejected');
    const denom = nonRejected.length;
    const sqls = nonRejected.filter(everReachedSql).length;
    const sqlRate = denom ? sqls / denom : 0;
    const stale = nonRejected.filter(d => d.status === 'stale').length;
    const noActivity = nonRejected.filter(d => !d.lastActivity && (d.status === 'active' || d.status === 'stale')).length;
    // Unworked = non-terminal, not currentlySql, no lastActivity, createdDate > 15 days ago.
    const nonTerminal = deals.filter(d =>
      d.status !== 'rejected' && d.status !== 'closed_won' && d.status !== 'closed_lost' && d.status !== 'withdrawn'
    );
    const unworked = nonTerminal.filter(d =>
      !currentlySql(d) && !d.lastActivity && daysSinceActivity(d, today) > 15
    ).length;
    const unworkedPct = nonTerminal.length ? unworked / nonTerminal.length : 0;
    const avgAge = denom ? nonRejected.reduce((s, d) => s + d.ageDays, 0) / denom : 0;
    const converted = nonRejected.filter(d => d.status === 'converted' || d.status === 'closed_won' || d.status === 'closed_lost').length;
    const wonDeals = nonRejected.filter(d => d.status === 'closed_won');
    const closedWon = wonDeals.length;
    const convRate = denom ? closedWon / denom : 0;
    const cohortRate = denom ? closedWon / denom : 0;
    const cycles = wonDeals.map(d => d.cycleDays).filter((n): n is number => typeof n === 'number');
    const avgCycle = cycles.length >= 2 ? cycles.reduce((s, n) => s + n, 0) / cycles.length : null;
    const rejectedByCam = new Map<string, { count: number; products: string[] }>();
    for (const d of deals) {
      if (d.status !== 'rejected') continue;
      const cam = d.channelAccountManager || '(none)';
      const e = rejectedByCam.get(cam) || { count: 0, products: [] };
      e.count++;
      if (d.product && !e.products.includes(d.product)) e.products.push(d.product);
      rejectedByCam.set(cam, e);
    }
    const cohort = buildCohortRows(nonRejected);
    const pipelineAmount = pipelineSum(nonRejected);
    const closedWonAmount = closedWonSum(nonRejected, oppMap);
    return { rep, assigned, rejected, sqls, sqlRate, stale, noActivity, unworked, unworkedPct, avgAge, converted, closedWon, convRate, cohortRate, avgCycle, pipelineAmount, closedWonAmount, rejectedByCam, cohort };
  });
  rows.sort((a, b) => b.assigned - a.assigned);
  if (!showInactiveReps) {
    return rows.filter(r => !inactiveRepNameSet.has(r.rep));
  }
  return rows;
}
