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
 * Gated on snapshot evidence: only heals a deal whose history shows it was actually Closed
 * Won/Lost in a prior import (proof of a genuine reopen). This deliberately spares deals
 * that were omitted while always open — e.g. test/junk deals never meant to count — which
 * would otherwise be wrongly pulled into open pipeline.
 *
 * Resets qualifying deals to 'unclassified' and drops stale Closed-Lost metadata, so they
 * re-enter open pipeline and the next import reclassifies them from fresh forecast evidence
 * (e.g. a Best Case + Upside deal → 'upside'). Pure and idempotent — a second pass heals 0.
 */
export function backfillReopenedClassifications(
  opps: Opportunity[],
  snapshots: { opportunityId: string; stage: string }[],
): { opportunities: Opportunity[]; healed: number } {
  // Opportunity ids (by history key = salesforceId) that were Closed Won/Lost in some prior
  // snapshot — the deal genuinely settled and later reopened.
  const everClosed = new Set<string>();
  for (const s of snapshots) {
    if (isClosedWonLostStage(s.stage)) everClosed.add(s.opportunityId);
  }
  const STALE = new Set<OpportunityClassification>(['omitted', 'lost', 'closed_won']);
  let healed = 0;
  const next = opps.map(o => {
    const histKey = o.salesforceId ?? o.id;
    if (isOpenStage(o.stage) && STALE.has(o.classification) && everClosed.has(histKey)) {
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
): OpportunityClassification {
  // Reopen guard: a settled Closed Won/Lost deal that comes back on an OPEN stage has
  // genuinely reopened. Its persisted terminal classification (omitted / lost / closed_won)
  // is now stale — do NOT carry it across the reopen. Clear it and let the incoming (open)
  // evidence reclassify the deal downstream.
  const reopened = isClosedWonLostStage(existingStage) && isOpenStage(incomingStage);
  if (reopened && (existingClassification === 'omitted' || existingClassification === 'lost' || existingClassification === 'closed_won')) {
    return incomingClassification;
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


