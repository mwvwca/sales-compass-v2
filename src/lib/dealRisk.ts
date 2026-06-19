import type { Opportunity, ChangeLogEntry } from '@/types/forecast';
import { currentlySql } from './drSql';

// ---- Tunables ----
export const STALE_DAYS = 30;      // open deal with no changelog movement in this many days
export const PUSH_FLAG_MIN = 2;    // close-date pushes before a deal is flagged "pushed"

/**
 * Risk flag kinds. `no_next_step` and `single_threaded` are defined now but NOT
 * populated — that data arrives in a later roadmap step. We never fabricate them.
 */
export type RiskFlagKind =
  | 'pushed'
  | 'stalled'
  | 'under_qualified'
  | 'no_next_step'
  | 'single_threaded';

export interface RiskFlag {
  kind: RiskFlagKind;
  detail?: string;
}

export interface AtRiskDeal {
  id: string;
  name: string;
  amount: number;
  stage: string;
  flags: RiskFlag[];
  /** Stage 2 (notes capture) — defined but unpopulated for now. */
  nextStep: string | null;
}

/** Group changelog entries by opportunity id (one pass, reused across opps). */
export function buildChangelogIndex(changelog: ChangeLogEntry[]): Map<string, ChangeLogEntry[]> {
  const byOpp = new Map<string, ChangeLogEntry[]>();
  for (const e of changelog) {
    const arr = byOpp.get(e.opportunityId);
    if (arr) arr.push(e); else byOpp.set(e.opportunityId, [e]);
  }
  return byOpp;
}

/**
 * The two time/movement signals for a deal:
 * - pushCount: number of close-date changes recorded in the changelog
 * - daysSinceMovement: days since the latest changelog import (falls back to importDate)
 */
export function dealRiskSignals(
  opp: Opportunity,
  index: Map<string, ChangeLogEntry[]>,
  today: Date,
): { pushCount: number; daysSinceMovement: number } {
  const entries = index.get(opp.id) ?? [];
  const pushCount = entries.filter(e => e.field === 'closeDate' && e.oldValue && e.newValue).length;
  const dates = entries.map(e => e.importDate).filter(Boolean);
  const last = dates.length ? dates.sort()[dates.length - 1] : opp.importDate;
  const d = last ? new Date(last) : null;
  const daysSinceMovement = (!d || isNaN(d.getTime()))
    ? 0
    : Math.max(0, Math.floor((today.getTime() - d.getTime()) / 86_400_000));
  return { pushCount, daysSinceMovement };
}

/** Compute the populated risk flags for a deal: pushed / stalled / under_qualified. */
export function flagDeal(opp: Opportunity, index: Map<string, ChangeLogEntry[]>, today: Date): RiskFlag[] {
  const { pushCount, daysSinceMovement } = dealRiskSignals(opp, index, today);
  const flags: RiskFlag[] = [];
  if (pushCount >= PUSH_FLAG_MIN) flags.push({ kind: 'pushed', detail: `close date pushed ${pushCount}×` });
  if (daysSinceMovement >= STALE_DAYS) flags.push({ kind: 'stalled', detail: `${daysSinceMovement}d no movement` });
  if (!currentlySql({ probability: opp.probability })) {
    flags.push({ kind: 'under_qualified', detail: `${Math.round((opp.probability ?? 0) * 100)}% probability` });
  }
  if (!opp.nextStep?.trim()) {
    flags.push({ kind: 'no_next_step', detail: 'no next step set' });
  }
  // 'single_threaded' still arrives in a later step — not populated yet.
  return flags;
}
