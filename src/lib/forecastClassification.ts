import type { Opportunity } from '@/types/forecast';

export type OpportunityClassification = Opportunity['classification'];

export function normalizeImportFlag(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

export function isTruthyForecastFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  const normalized = normalizeImportFlag(value);
  return normalized === 'true' || normalized === 'yes' || normalized === 'y' || normalized === '1' || normalized === 'commit' || normalized === 'forecast';
}

export function isTruthyUpsideFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  const normalized = normalizeImportFlag(value);
  return normalized === 'true' || normalized === 'yes' || normalized === 'y' || normalized === '1' || normalized === 'upside';
}

export function getImportedClassification(params: {
  stage?: unknown;
  forecastCategory?: unknown;
  forecastFlag?: unknown;
  upsideFlag?: unknown;
}): OpportunityClassification {
  const stageNorm = normalizeImportFlag(params.stage).replace(/[-_/]/g, ' ').replace(/\s+/g, ' ');
  if (stageNorm === 'closed won') return 'closed_won';
  if (stageNorm === 'closed lost') return 'lost';
  if (stageNorm === 'rejected') return 'rejected';

  const categoryNorm = normalizeImportFlag(params.forecastCategory).replace(/[-_/]/g, ' ').replace(/\s+/g, ' ');
  if (categoryNorm === 'commit') return 'commit';
  if (categoryNorm === 'upside') return 'upside';
  if (categoryNorm === 'omitted') return 'omitted';
  if (categoryNorm === 'rejected') return 'rejected';

  if (isTruthyForecastFlag(params.forecastFlag)) return 'commit';
  if (isTruthyUpsideFlag(params.upsideFlag)) return 'upside';

  return 'unclassified';
}

export interface HudPipeTotals {
  /** Open + commit + upside + closed won in scope (excludes lost/omitted/rejected). */
  totalPipe: number;
  /** Closed lost in scope (excludes omitted/rejected). */
  closedLost: number;
  /** Everything that was in play regardless of outcome: totalPipe + closedLost. */
  startingPipe: number;
}

/**
 * Partition an already period+rep-scoped opportunity set into the HUD pipe figures.
 * Mirrors ForecastDashboard's listOpps/lostOpps/hudOpps split exactly:
 *  - a "closed lost" deal (classification 'lost' or stage 'closed lost') feeds closedLost
 *  - every other deal, minus omitted/rejected, feeds totalPipe (open + commit + upside + won)
 *  - omitted/rejected deals feed neither
 * Because totalPipe already spans open + closed won, startingPipe = totalPipe + closedLost
 * reconstructs the full open + won + lost universe with no double-count, and the identity
 * `startingPipe - closedLost === totalPipe` holds by construction for any scope.
 */
export function computeHudPipe(scopedOpps: Opportunity[]): HudPipeTotals {
  let totalPipe = 0;
  let closedLost = 0;
  for (const o of scopedOpps) {
    if (o.classification === 'omitted' || o.classification === 'rejected') continue;
    const isLost = o.classification === 'lost' || o.stage.toLowerCase().trim() === 'closed lost';
    if (isLost) closedLost += o.amount;
    else totalPipe += o.amount;
  }
  return { totalPipe, closedLost, startingPipe: totalPipe + closedLost };
}

const normStage = (stage: string | undefined): string =>
  normalizeImportFlag(stage).replace(/[-_/]/g, ' ').replace(/\s+/g, ' ');

/**
 * Probability (0–1) at or above which a deal is 'qualified' — the SQL gate (25%).
 * Used as the guard for clearing an 'omitted' classification: because there is no
 * provenance to tell a manager's deliberate omit from a system-derived one, an omit is
 * only ever cleared on a qualified record — never resurrected below this threshold.
 */
export const QUALIFICATION_THRESHOLD = 0.25;

/** A settled Closed Won / Closed Lost stage. */
export function isClosedWonLostStage(stage: string | undefined): boolean {
  const s = normStage(stage);
  return s === 'closed won' || s === 'closed lost';
}

/** An OPEN (non-terminal, non-blank) stage — not Closed Won/Lost/Rejected. */
export function isOpenStage(stage: string | undefined): boolean {
  const s = normStage(stage);
  return s !== '' && s !== 'closed won' && s !== 'closed lost' && s !== 'rejected';
}

/**
 * One-time heal for deals stranded by a reopen that happened BEFORE the reopen-clear
 * shipped: their stage is already open again, but their classification is still a stale
 * terminal value (omitted / lost / closed_won) left over from when the stage was closed.
 * The forward-looking reopen-clear can't catch these — the closed→open transition already
 * happened, so the stored stage is open and no future import re-detects it.
 *
 * Heals two stranded populations, both left behind because their current stage is stable
 * so merge-time clearing never fires:
 *   - lost / closed_won on an open stage, gated on snapshot evidence that the deal was
 *     actually Closed Won/Lost before (proof of a genuine reopen). Spares deals never closed.
 *   - omitted on an open stage AT/ABOVE the qualification threshold. Because classification
 *     carries no provenance (can't tell a deliberate omit from a derived one), an omit is
 *     healed only on a qualified open deal — never below qualification, where a deliberate
 *     omit of an early/junk deal is left untouched.
 *
 * Resets qualifying deals to 'unclassified' and drops stale Closed-Lost metadata, so they
 * re-enter open pipeline and the next import reclassifies them from fresh forecast evidence
 * (e.g. a Best Case + Upside deal → 'upside'). Pure, and idempotent on unchanged input — a
 * second pass heals 0.
 *
 * PROVENANCE GUARD. This is the one flag-gated backfill that rewrites a manager-editable
 * field (classification). Its migration flag now lives in the cloud (app_state), but a fresh
 * device on a legacy account — where the first run only left a localStorage flag — can still
 * re-run it once against already-migrated cloud data. In that window a manager may have
 * DELIBERATELY set an open, qualified deal to 'omitted' (or manually to closed_won/lost);
 * without provenance the heal would silently undo that. Classification changelog entries are
 * only ever written by the manual classify action (fileName '(manual)'; imports never log
 * classification), so `changelog` is a reliable, cloud-synced record of manual calls. A deal
 * whose CURRENT classification equals its latest manual classification entry is a live manager
 * decision and is left untouched.
 */
export function backfillReopenedClassifications(
  opps: Opportunity[],
  snapshots: { opportunityId: string; stage: string }[],
  changelog: { opportunityId: string; field: string; newValue: string; importDate: string; fileName: string }[] = [],
): { opportunities: Opportunity[]; healed: number } {
  // Opportunity ids (by history key = salesforceId) that were Closed Won/Lost in some prior
  // snapshot — the deal genuinely settled and later reopened.
  const everClosed = new Set<string>();
  for (const s of snapshots) {
    if (isClosedWonLostStage(s.stage)) everClosed.add(s.opportunityId);
  }

  // Latest MANUAL classification value per history key. Every classification changelog entry
  // is manual by construction, but the fileName check keeps the intent explicit and safe if
  // that ever changes.
  const latestManualClass = new Map<string, string>();
  const latestManualAt = new Map<string, string>();
  for (const e of changelog) {
    if (e.field !== 'classification' || e.fileName !== '(manual)') continue;
    const prevAt = latestManualAt.get(e.opportunityId);
    if (!prevAt || e.importDate.localeCompare(prevAt) >= 0) {
      latestManualAt.set(e.opportunityId, e.importDate);
      latestManualClass.set(e.opportunityId, e.newValue);
    }
  }

  let healed = 0;
  const next = opps.map(o => {
    if (!isOpenStage(o.stage)) return o;
    const histKey = o.salesforceId ?? o.id;
    // Provenance guard: current classification is the manager's own latest manual call — leave it.
    if (latestManualClass.get(histKey) === o.classification) return o;
    const reopenedTerminal =
      (o.classification === 'lost' || o.classification === 'closed_won') && everClosed.has(histKey);
    const strandedOmitted =
      o.classification === 'omitted' && (o.probability ?? 0) >= QUALIFICATION_THRESHOLD;
    if (reopenedTerminal || strandedOmitted) {
      healed++;
      return {
        ...o,
        previousClassification: o.classification,
        classification: 'unclassified' as const,
        lostDate: undefined,
        lostReason: undefined,
      };
    }
    return o;
  });
  return { opportunities: next, healed };
}

export function resolveImportedClassification(
  existingClassification: OpportunityClassification,
  incomingClassification: OpportunityClassification,
  existingStage?: string,
  incomingStage?: string,
  incomingProbability?: number,
): OpportunityClassification {
  // A stage change means the deal has moved — do NOT carry a stale TERMINAL classification
  // across it; recompute from the incoming snapshot. This generalizes the old closed→open
  // reopen guard to any stage change (e.g. Rejected→Discovery, Unqualified→Discovery).
  // Only terminal states are cleared, so a manager's manual commit/upside forecast call is
  // never touched. 'omitted' has no provenance (can't tell a deliberate omit from a derived
  // one), so it clears only on a QUALIFIED record — an omit below the qualification threshold
  // is left alone.
  const stageChanged = normStage(incomingStage) !== '' && normStage(existingStage) !== normStage(incomingStage);
  if (stageChanged) {
    if (existingClassification === 'lost' || existingClassification === 'closed_won' || existingClassification === 'rejected') {
      return incomingClassification;
    }
    if (existingClassification === 'omitted' && (incomingProbability ?? 0) >= QUALIFICATION_THRESHOLD) {
      return incomingClassification;
    }
  }

  if (existingClassification === 'omitted') return 'omitted';
  if (incomingClassification === 'omitted') return 'omitted';
  if (existingClassification === 'closed_won') return 'closed_won';
  if (existingClassification === 'lost') return 'lost';
  if (existingClassification === 'rejected') return 'rejected';
  if (incomingClassification === 'closed_won' || incomingClassification === 'lost' || incomingClassification === 'rejected') return incomingClassification;
  if (incomingClassification === 'commit' || incomingClassification === 'upside') return incomingClassification;
  return existingClassification;
}


