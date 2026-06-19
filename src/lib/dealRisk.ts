import type { Opportunity, ChangeLogEntry } from '@/types/forecast';
import { currentlySql } from './drSql';
import type { TranscriptSignals } from './transcripts';

// ---- Tunables ----
export const STALE_DAYS = 30;      // open deal with no changelog movement in this many days
export const PUSH_FLAG_MIN = 2;    // close-date pushes before a deal is flagged "pushed"

/**
 * Risk flag kinds. `single_threaded` and `negative_sentiment` are populated only
 * when transcript signals are supplied to flagDeal — never fabricated otherwise.
 * `vague_next_step` is populated only when an AI quality classification is supplied.
 */
export type RiskFlagKind =
  | 'pushed'
  | 'stalled'
  | 'under_qualified'
  | 'no_next_step'
  | 'vague_next_step'
  | 'single_threaded'
  | 'negative_sentiment';

export interface RiskFlag {
  kind: RiskFlagKind;
  detail?: string;
  /** Coaching sentence: the rule that fired + the remedy. */
  why?: string;
}

export interface AtRiskDeal {
  id: string;
  name: string;
  salesforceId?: string;
  closeDate?: string;
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
/**
 * Risk flags for a deal. `nextStepQuality` (optional) is the AI classification of
 * a non-empty next step: when 'vague' it adds a softer `vague_next_step` flag. An
 * empty next step still produces the harder `no_next_step` flag. `signals` (optional)
 * are the latest call-transcript signals: a lone stakeholder adds `single_threaded`
 * and a negative read adds `negative_sentiment`.
 */
export function flagDeal(
  opp: Opportunity,
  index: Map<string, ChangeLogEntry[]>,
  today: Date,
  nextStepQuality?: 'concrete' | 'vague',
  signals?: TranscriptSignals,
): RiskFlag[] {
  const { pushCount, daysSinceMovement } = dealRiskSignals(opp, index, today);
  const flags: RiskFlag[] = [];
  if (pushCount >= PUSH_FLAG_MIN) {
    flags.push({ kind: 'pushed', detail: `close date pushed ${pushCount}×`, why: `Close date pushed ${pushCount}× — repeated slips mean it is not progressing as forecast.` });
  }
  if (daysSinceMovement >= STALE_DAYS) {
    flags.push({ kind: 'stalled', detail: `${daysSinceMovement}d no movement`, why: `No changelog movement in ${daysSinceMovement}d — the deal has gone quiet.` });
  }
  if (!currentlySql({ probability: opp.probability })) {
    const pct = Math.round((opp.probability ?? 0) * 100);
    flags.push({ kind: 'under_qualified', detail: `${pct}% probability`, why: `${pct}% is below the 25% SQL gate — not yet qualified; needs to reach 25%+.` });
  }
  if (!opp.nextStep?.trim()) {
    flags.push({ kind: 'no_next_step', detail: 'no next step set', why: 'No next step logged in Salesforce — the rep has not set what happens next.' });
  } else if (nextStepQuality === 'vague') {
    flags.push({ kind: 'vague_next_step', detail: 'vague next step', why: 'The next step reads as generic filler, not a concrete dated action.' });
  }
  if (signals && signals.stakeholders.length <= 1) {
    flags.push({ kind: 'single_threaded', detail: 'single-threaded', why: 'Only one stakeholder engaged on recent calls — deal is single-threaded.' });
  }
  if (signals?.sentiment === 'negative') {
    flags.push({ kind: 'negative_sentiment', detail: 'negative sentiment', why: 'Latest call sentiment read as negative.' });
  }
  return flags;
}
