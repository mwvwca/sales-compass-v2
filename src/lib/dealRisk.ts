import type { Opportunity, ChangeLogEntry } from '@/types/forecast';
import { currentlySql } from './drSql';
import type { TranscriptSignals } from './transcripts';

// ---- Tunables ----
export const STALE_DAYS = 30;      // open deal with no changelog movement in this many days
export const PUSH_FLAG_MIN = 2;    // close-date pushes before a deal is flagged "pushed"

/**
 * Risk flag kinds. The transcript-signal flags (`single_threaded`,
 * `negative_sentiment`, `competitor_present`, `risk_flagged`) are populated only
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
  | 'negative_sentiment'
  | 'competitor_present'
  | 'risk_flagged';

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
  /** Imported Salesforce description (rep narrative); evidence for the 1:1 coach. */
  description?: string;
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

export interface SlipProfile {
  changes: number;        // total close-date changes logged
  slips: number;          // moves to a later date (the deal slipping)
  pulls: number;          // moves to an earlier date
  firstClose?: string;    // earliest close date on record
  currentClose?: string;  // latest close date on record
  slipDays: number;       // net days from first to current close (positive = slipped later)
}

/**
 * Close-date trajectory from the changelog: not just how many times a deal moved,
 * but how many of those were slips (later) vs pulls (earlier) and the net drift in
 * days. Turns a blunt "pushed Nx" into "slipped 5x, Apr 30 to Jun 26".
 */
export function slipProfile(opp: Opportunity, index: Map<string, ChangeLogEntry[]>): SlipProfile {
  const entries = (index.get(opp.id) ?? [])
    .filter(e => e.field === 'closeDate' && e.oldValue && e.newValue)
    .sort((a, b) => (a.importDate ?? '').localeCompare(b.importDate ?? ''));
  let slips = 0, pulls = 0;
  for (const e of entries) {
    const o = Date.parse(e.oldValue as string), n = Date.parse(e.newValue as string);
    if (isNaN(o) || isNaN(n)) continue;
    if (n > o) slips += 1; else if (n < o) pulls += 1;
  }
  const firstClose = entries[0]?.oldValue ?? undefined;
  const currentClose = entries[entries.length - 1]?.newValue ?? opp.closeDate ?? undefined;
  let slipDays = 0;
  if (firstClose && currentClose) {
    const f = Date.parse(firstClose), c = Date.parse(currentClose);
    if (!isNaN(f) && !isNaN(c)) slipDays = Math.round((c - f) / 86_400_000);
  }
  return { changes: entries.length, slips, pulls, firstClose, currentClose, slipDays };
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
    const sp = slipProfile(opp, index);
    const detail = sp.slips >= 1 && sp.firstClose && sp.currentClose
      ? `slipped ${sp.slips}×, ${sp.firstClose} → ${sp.currentClose}`
      : `close date changed ${pushCount}×`;
    flags.push({ kind: 'pushed', detail, why: `Close date changed ${pushCount}× (${sp.slips} slip${sp.slips !== 1 ? 's' : ''}, net ${sp.slipDays >= 0 ? '+' : ''}${sp.slipDays}d) — repeated slips mean it is not progressing as forecast.` });
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
  if (signals && signals.competitors.length > 0) {
    flags.push({ kind: 'competitor_present', detail: signals.competitors.join(', '), why: `Competitor named on recent calls: ${signals.competitors.join(', ')}.` });
  }
  if (signals && signals.risks.length > 0) {
    flags.push({ kind: 'risk_flagged', detail: `${signals.risks.length} risk${signals.risks.length > 1 ? 's' : ''} noted`, why: `Risks raised on recent calls: ${signals.risks.join('; ')}.` });
  }
  return flags;
}
