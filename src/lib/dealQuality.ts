import type { DealRegistration } from '@/types/forecast';
import { everReachedSql } from './drSql';

/** Minimum resolved deals before win rate is considered reliable. */
export const MIN_RESOLVED = 10;

export interface DealQualityCore {
  /** Non-rejected DRs in scope. */
  total: number;
  /** Non-rejected DRs that ever reached SQL (includes lost-after-qualifying). */
  reachedSQL: number;
  /** reachedSQL / total. */
  sqlRate: number;
  /** Closed Won DRs. */
  closedWon: number;
  /** Resolved DRs (Closed Won + Closed Lost). */
  resolvedCount: number;
  /** Closed Won among resolved (equals closedWon; kept explicit for the ratio). */
  closedWonR: number;
  /** Win rate: closedWonR / resolvedCount. null when nothing has resolved yet. */
  winRate: number | null;
  /** Cohort rate: closedWon / total. */
  overallCohortRate: number;
}

/**
 * Core deal-quality metrics shared by the dashboard (DrPipeline) and the AI
 * briefing (briefingDataBuilder) — the single source of truth for these
 * definitions so they can't drift between the two call sites.
 *
 * Win rate is the conventional Closed Won / (Closed Won + Closed Lost) over ALL
 * resolved deals. It is NOT gated on everReachedSql, so deals imported
 * already-closed (no observed open SQL stage, no sqlDate) are still counted.
 * Returns null when nothing has resolved yet — the display layer must guard.
 *
 * Works for any DR slice: full scope, defensible-only, or per-CAM. Rejected
 * deals are excluded from `total`/`reachedSQL`; resolved/closedWon are taken
 * over the whole slice (rejected deals are never Closed Won/Lost anyway).
 */
export function computeDealQualityCore(drs: DealRegistration[]): DealQualityCore {
  const nonRej = drs.filter(d => d.status !== 'rejected');
  const total = nonRej.length;
  const reachedSQL = nonRej.filter(everReachedSql).length;
  const closedWon = drs.filter(d => d.status === 'closed_won').length;
  const resolved = drs.filter(d => d.status === 'closed_won' || d.status === 'closed_lost');
  const closedWonR = resolved.filter(d => d.status === 'closed_won').length;
  const resolvedCount = resolved.length;
  const winRate: number | null = resolvedCount > 0 ? closedWonR / resolvedCount : null;
  const overallCohortRate = total > 0 ? closedWon / total : 0;
  const sqlRate = total > 0 ? reachedSQL / total : 0;
  return { total, reachedSQL, sqlRate, closedWon, resolvedCount, closedWonR, winRate, overallCohortRate };
}
