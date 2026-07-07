import type { ChangeLogEntry, Opportunity } from '@/types/forecast';
import { rowsForOpportunity } from './historyKey';

/**
 * POV / RFP tracking.
 *
 * Neither motion is a Salesforce field; the only signal is the token appearing
 * in the opportunity name. Two sources give us the lifecycle:
 *   1. Current names: which deals are in a POV/RFP right now.
 *   2. The name-change changelog: the import on which the token first appeared
 *      in a deal's name is the motion's start date (exact to the import cadence).
 * If the token was already present at first import, the deal's importDate is
 * used as a lower bound and the row is marked approximate.
 */

export type MotionKind = 'POV' | 'RFP';

const TOKEN_PATTERNS: Record<MotionKind, RegExp> = {
  POV: /\bPOV\b/i,
  RFP: /\bRFP\b/i,
};

export interface MotionRecord {
  opportunityId: string;
  salesforceId?: string;
  name: string;
  repName: string;
  amount: number;
  closeDate: string;
  classification: string;
  kind: MotionKind;
  /** ISO date the token first appeared in the name. */
  startedAt: string;
  /** true when startedAt is the first-import date rather than an observed name change. */
  startApproximate: boolean;
  /** Days from start to today (open) or to conclusion (closed). */
  durationDays: number;
  outcome: 'active' | 'won' | 'lost' | 'rejected';
}

export interface MotionStats {
  kind: MotionKind;
  activeCount: number;
  activeAmount: number;
  concludedCount: number;
  wonCount: number;
  /** wonCount / concludedCount, null when nothing has concluded. */
  conversionRate: number | null;
  /** Median start-to-conclusion days across concluded motions, null when none. */
  medianDurationDays: number | null;
}

export function hasMotionToken(name: string, kind: MotionKind): boolean {
  return TOKEN_PATTERNS[kind].test(name || '');
}

function outcomeOf(o: Opportunity): MotionRecord['outcome'] {
  if (o.classification === 'closed_won') return 'won';
  if (o.classification === 'lost') return 'lost';
  if (o.classification === 'rejected') return 'rejected';
  const stage = (o.stage || '').toLowerCase();
  if (stage.includes('closed won')) return 'won';
  if (stage.includes('closed lost')) return 'lost';
  return 'active';
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (!isFinite(from) || !isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86400000));
}

/**
 * Find when `kind`'s token first appeared in the deal's name.
 * Omitted deals are excluded entirely (test data by definition).
 */
export function detectMotions(
  opportunities: Opportunity[],
  changelog: ChangeLogEntry[],
  kind: MotionKind,
  now: Date = new Date(),
): MotionRecord[] {
  const nameChanges = changelog.filter(c => c.field === 'name');
  const byOpp = new Map<string, ChangeLogEntry[]>();
  for (const c of nameChanges) {
    const list = byOpp.get(c.opportunityId);
    if (list) list.push(c); else byOpp.set(c.opportunityId, [c]);
  }

  const records: MotionRecord[] = [];
  for (const o of opportunities) {
    if (o.classification === 'omitted') continue;
    if (!hasMotionToken(o.name, kind)) continue;

    // Earliest name change where the token was added.
    const changes = rowsForOpportunity(byOpp, o)
      .filter(c =>
        hasMotionToken(String(c.newValue ?? ''), kind) &&
        !hasMotionToken(String(c.oldValue ?? ''), kind))
      .sort((a, b) => a.importDate.localeCompare(b.importDate));

    const startedAt = changes[0]?.importDate ?? o.importDate;
    const startApproximate = changes.length === 0;
    const outcome = outcomeOf(o);
    const endIso = outcome === 'active'
      ? now.toISOString()
      : (o.lostDate || o.closeDate || now.toISOString());

    records.push({
      opportunityId: o.id,
      salesforceId: o.salesforceId,
      name: o.name,
      repName: o.repName,
      amount: o.amount,
      closeDate: o.closeDate,
      classification: o.classification,
      kind,
      startedAt,
      startApproximate,
      durationDays: daysBetween(startedAt, endIso),
      outcome,
    });
  }

  return records.sort((a, b) => {
    if ((a.outcome === 'active') !== (b.outcome === 'active')) return a.outcome === 'active' ? -1 : 1;
    return b.durationDays - a.durationDays;
  });
}

export function motionStats(records: MotionRecord[], kind: MotionKind): MotionStats {
  const active = records.filter(r => r.outcome === 'active');
  const concluded = records.filter(r => r.outcome !== 'active');
  const won = concluded.filter(r => r.outcome === 'won');
  // Duration is only trustworthy when the start came from an observed name
  // change; approximate (first-import) starts would drag the median toward 0.
  const durations = concluded.filter(r => !r.startApproximate).map(r => r.durationDays).sort((a, b) => a - b);
  const median = durations.length
    ? durations.length % 2
      ? durations[(durations.length - 1) / 2]
      : Math.round((durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2)
    : null;

  return {
    kind,
    activeCount: active.length,
    activeAmount: active.reduce((a, r) => a + r.amount, 0),
    concludedCount: concluded.length,
    wonCount: won.length,
    conversionRate: concluded.length ? won.length / concluded.length : null,
    medianDurationDays: median,
  };
}
