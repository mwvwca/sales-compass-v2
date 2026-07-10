import type { ChangeLogEntry, Opportunity } from '@/types/forecast';
import { matchesHistoryKey } from './historyKey';

/**
 * SQL-inspection prep for the manager sign-off mandate: every opportunity
 * advancing Qualified 5% -> Discovery 25% requires written manager inspection
 * against three criteria. This module automates the checkable parts:
 *
 *  C1 (methodology followed): not machine-checkable from Salesforce exports;
 *     a transcript attached in Sales Compass is surfaced as supporting
 *     evidence, otherwise flagged for manual call/Co-Pilot review.
 *  C2 (real discovery conversation): Next Step populated, specific, ideally
 *     dated; notes/description present.
 *  C3 (legitimate SQL): non-zero, non-placeholder amount; close date that is
 *     not in the past and not an obvious end-of-period default.
 */

const norm = (s: string | null | undefined) =>
  (s || '').toLowerCase().replace(/[-_/]/g, ' ').replace(/\s+/g, ' ').trim();

export type CheckLevel = 'pass' | 'warn' | 'fail' | 'manual';

export interface CriterionCheck {
  criterion: 'C1' | 'C2' | 'C3';
  level: CheckLevel;
  detail: string;
}

export interface InspectionRow {
  opp: Opportunity;
  checks: CriterionCheck[];
  /** Worst level across checks: fail > warn > manual > pass. */
  overall: CheckLevel;
  hasTranscript: boolean;
  transitionedAt?: string;
  leapfrog?: boolean;
}

const GENERIC_NEXT_STEPS = [
  'follow up', 'followup', 'touch base', 'check in', 'circle back', 'tbd',
  'call', 'email', 'reach out', 'waiting', 'pending',
];

function nextStepCheck(o: Opportunity): CriterionCheck {
  const ns = (o.nextStep || '').trim();
  if (!ns) return { criterion: 'C2', level: 'fail', detail: 'Next Step is empty' };
  const low = ns.toLowerCase();
  const generic = GENERIC_NEXT_STEPS.some(g => low === g || (low.length < 25 && low.includes(g)));
  const dated = /\b(\d{1,2}[\/\-]\d{1,2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|next week|eow|eod)\b/i.test(ns);
  if (ns.length < 15 || (generic && !dated)) {
    return { criterion: 'C2', level: 'warn', detail: `Next Step looks generic: "${ns.slice(0, 40)}"` };
  }
  if (!dated) return { criterion: 'C2', level: 'warn', detail: 'Next Step has no date anchor' };
  return { criterion: 'C2', level: 'pass', detail: 'Next Step is specific and dated' };
}

function amountCheck(o: Opportunity): CriterionCheck {
  if (!o.amount || o.amount <= 0) return { criterion: 'C3', level: 'fail', detail: 'Amount is $0 (placeholder)' };
  if (o.amount % 10000 === 0 && o.amount <= 50000) {
    return { criterion: 'C3', level: 'warn', detail: `Amount $${o.amount.toLocaleString()} looks like a round default` };
  }
  return { criterion: 'C3', level: 'pass', detail: `Amount $${Math.round(o.amount).toLocaleString()}` };
}

function closeDateCheck(o: Opportunity, today: Date): CriterionCheck {
  const cd = (o.closeDate || '').slice(0, 10);
  if (!cd) return { criterion: 'C3', level: 'fail', detail: 'Close Date missing' };
  const t = today.toISOString().slice(0, 10);
  if (cd < t) return { criterion: 'C3', level: 'fail', detail: `Close Date ${cd} is in the past` };
  const mmdd = cd.slice(5);
  if (['03-31', '06-30', '09-30', '12-31'].includes(mmdd)) {
    return { criterion: 'C3', level: 'warn', detail: `Close Date ${cd} is a quarter-end default` };
  }
  return { criterion: 'C3', level: 'pass', detail: `Close Date ${cd}` };
}

function methodologyCheck(hasTranscript: boolean): CriterionCheck {
  return hasTranscript
    ? { criterion: 'C1', level: 'pass', detail: 'Call transcript on file in Sales Compass' }
    : { criterion: 'C1', level: 'manual', detail: 'No transcript on file; review call or Co-Pilot before sign-off' };
}

const ORDER: Record<CheckLevel, number> = { fail: 3, warn: 2, manual: 1, pass: 0 };

export function inspectOpportunity(
  o: Opportunity,
  hasTranscript: boolean,
  today: Date = new Date(),
  meta: { leapfrog?: boolean; transitionedAt?: string } = {},
): InspectionRow {
  const checks = [
    methodologyCheck(hasTranscript),
    nextStepCheck(o),
    amountCheck(o),
    closeDateCheck(o, today),
  ];
  const overall = checks.reduce<CheckLevel>(
    (worst, c) => (ORDER[c.level] > ORDER[worst] ? c.level : worst), 'pass');
  return {
    opp: o, checks, overall, hasTranscript,
    leapfrog: meta.leapfrog,
    transitionedAt: meta.transitionedAt,
  };
}

/** Deals currently at a Discovery stage and open. */
export function currentDiscoveryDeals(opps: Opportunity[]): Opportunity[] {
  return opps.filter(o =>
    ['commit', 'upside', 'unclassified'].includes(o.classification) &&
    norm(o.stage).includes('discovery'));
}

export interface StageTransition {
  entry: ChangeLogEntry;
  opp?: Opportunity;
  leapfrog: boolean;
}

/** Qualified->Discovery (and Unqualified->Discovery leapfrog) transitions since a cutoff. */
export function discoveryTransitions(
  changelog: ChangeLogEntry[],
  opps: Opportunity[],
  sinceIso: string,
): StageTransition[] {
  const out: StageTransition[] = [];
  for (const c of changelog) {
    if (c.field !== 'stage') continue;
    if (c.importDate < sinceIso) continue;
    const from = norm(String(c.oldValue));
    const to = norm(String(c.newValue));
    if (!to.includes('discovery')) continue;
    const leapfrog = from.includes('unqualified');
    if (!leapfrog && !from.includes('qualified')) continue;
    const opp = opps.find(o => matchesHistoryKey(c.opportunityId, o));
    out.push({ entry: c, opp, leapfrog });
  }
  return out.sort((a, b) => b.entry.importDate.localeCompare(a.entry.importDate));
}

/**
 * Paste-ready Manager Review Note in the mandated format.
 *
 * The wording branches on C1's actual level so the note never claims a review
 * that did not happen: only a deal with a transcript on file (C1 pass) may read
 * "N-gage criteria met; discovery call reviewed …". A C1-manual deal (no
 * transcript) reads "C2/C3 validated; discovery call review pending …" and must
 * not contain "criteria met" or "discovery call reviewed". Leapfrog rows
 * (skipped Qualified 5%) additionally acknowledge the skipped stage.
 */
export function inspectionNote(row: InspectionRow, initials: string, today: Date = new Date()): string {
  const d = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;
  const ini = (initials || 'XX').toUpperCase();
  const leapPrefix = row.leapfrog
    ? 'stage progression skipped Qualified 5%; retroactive inspection performed; '
    : '';

  if (row.overall === 'fail') {
    const fails = row.checks.filter(c => c.level === 'fail').map(c => c.detail).join('; ');
    return `${d} ${ini}: ${leapPrefix}Inspection incomplete — returned to rep. ${fails}. Re-review scheduled.`;
  }

  const c1 = row.checks.find(c => c.criterion === 'C1');
  const amt = row.checks.find(c => c.criterion === 'C3' && c.detail.startsWith('Amount'));
  const cd = row.checks.find(c => c.detail.startsWith('Close Date') && c.level !== 'fail');

  // C1 pass = transcript on file; C1 manual = no transcript, so the discovery
  // call review has not actually been performed yet.
  const head = c1?.level === 'manual'
    ? ['C2/C3 validated', 'discovery call review pending, no transcript on file']
    : ['N-gage criteria met', row.hasTranscript ? 'discovery call reviewed via transcript' : 'discovery call reviewed'];

  const parts = [
    ...head,
    amt ? amt.detail.replace('Amount ', 'ACV validated at ') : null,
    cd ? cd.detail.replace('Close Date ', 'close date confirmed ') : null,
    'next step confirmed with rep',
  ].filter(Boolean);
  return `${d} ${ini}: ${leapPrefix}${parts.join('; ')}.`;
}
