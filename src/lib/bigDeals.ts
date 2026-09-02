import type { ChangeLogEntry, Opportunity, OpportunitySnapshot, Rep, Quarter } from '@/types/forecast';
import { getMonthKey, getQuarter, getISOWeekRange, quarterEnd, quarterStart } from '@/types/forecast';
import { isOpenStage } from './forecastClassification';
import { buildTeamRepNameSet, isTeamOwned, isTeamStatus } from './repUtils';
import { reconcileQuote, type QuoteState } from './quoteReconciliation';
import { daysSinceStageChange, stageHistoryFor } from './stageStaleness';
import { involvementFor, involvementKey, INVOLVEMENT_META, type InvolvementEntry, type InvolvementMap } from './involvement';

/**
 * The "big deals" cohort and the Friday briefing built from it.
 *
 * The cohort is the manager's standing weekly ask: every open, team-owned deal closing
 * in the selected month at or above a dollar threshold. Nothing here computes a value a
 * different way than the views do — team membership is `isTeamOwned` at render time,
 * openness is `isOpenStage`, the amount flags are `reconcileQuote`, staleness is
 * `daysSinceStageChange`, and week-over-week movement is read from the import changelog
 * (the same rows lib/inspection reads for stage transitions) rather than re-diffed here.
 * Every number in the email can be pointed at on screen.
 */

export const DEFAULT_BIG_DEAL_THRESHOLD = 30000;
export const DEFAULT_MONTHLY_TARGET = 1_200_000;
/** Pipeline ÷ remaining goal below which a rep's quarter is called thin. */
export const DEFAULT_COVERAGE_LINE = 3;

export interface BigDealRow {
  opp: Opportunity;
  /** Involvement key — the Salesforce id, falling back to the internal id. */
  key: string;
  quoteState: QuoteState;
  involvement: InvolvementEntry;
  /** Whole days since the deal's current stage was reached; null with no usable anchor. */
  daysInStage: number | null;
}

/**
 * Cohort membership as captured at a briefing generation, so the next briefing can say
 * which deals left and why without having to reconstruct history.
 */
export interface BriefingCohortMember {
  key: string;
  name: string;
  rep: string;
  amount: number;
  stage: string;
  closeDate: string;
}

/** One recorded briefing generation: what the cohort was, under which selection. */
export interface BriefingRun {
  /** ISO timestamp of the generation. '' = no run recorded. */
  generatedAt: string;
  monthKey: string;
  threshold: number;
  cohort: BriefingCohortMember[];
}

export const EMPTY_RUN: BriefingRun = { generatedAt: '', monthKey: '', threshold: DEFAULT_BIG_DEAL_THRESHOLD, cohort: [] };

/**
 * Persisted briefing state (app_state key `forecast_briefing_meta`). Never null.
 *
 * Two runs are kept, not one: `current` is this period's briefing and `previous` is the
 * one it is measured against. Regenerating on the same Friday replaces `current` and
 * leaves `previous` alone, so the second run still reports the whole week rather than
 * the five minutes since the first.
 */
export interface BriefingMeta {
  /** Briefing period (ISO-week Monday, YYYY-MM-DD) that `current` belongs to. */
  periodKey: string;
  current: BriefingRun;
  previous: BriefingRun;
  /** Monthly target the header is phrased against. */
  monthlyTarget: number;
  /** Coverage line reps are flagged below. */
  coverageLine: number;
  /** Period the rep commentary belongs to. A new period starts the text fresh. */
  notesPeriod: string;
  /** repName → this period's activity/guidance line. */
  repNotes: Record<string, string>;
}

export const EMPTY_BRIEFING_META: BriefingMeta = {
  periodKey: '',
  current: EMPTY_RUN,
  previous: EMPTY_RUN,
  monthlyTarget: DEFAULT_MONTHLY_TARGET,
  coverageLine: DEFAULT_COVERAGE_LINE,
  notesPeriod: '',
  repNotes: {},
};

function cleanRun(raw: unknown): BriefingRun {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_RUN };
  const v = raw as Partial<BriefingRun>;
  return {
    generatedAt: typeof v.generatedAt === 'string' ? v.generatedAt : '',
    monthKey: typeof v.monthKey === 'string' ? v.monthKey : '',
    threshold: typeof v.threshold === 'number' && isFinite(v.threshold) ? v.threshold : DEFAULT_BIG_DEAL_THRESHOLD,
    cohort: Array.isArray(v.cohort)
      ? v.cohort.filter((m): m is BriefingCohortMember => !!m && typeof (m as BriefingCohortMember).key === 'string')
      : [],
  };
}

/** Cleaner for the persisted slice: a malformed value must never reach the UI as null. */
export function cleanBriefingMeta(raw: unknown): BriefingMeta {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_BRIEFING_META };
  const v = raw as Partial<BriefingMeta>;
  const notes: Record<string, string> = {};
  if (v.repNotes && typeof v.repNotes === 'object' && !Array.isArray(v.repNotes)) {
    for (const [k, text] of Object.entries(v.repNotes)) if (typeof text === 'string') notes[k] = text;
  }
  const num = (x: unknown, fallback: number) => (typeof x === 'number' && isFinite(x) ? x : fallback);
  return {
    periodKey: typeof v.periodKey === 'string' ? v.periodKey : '',
    current: cleanRun(v.current),
    previous: cleanRun(v.previous),
    monthlyTarget: num(v.monthlyTarget, DEFAULT_MONTHLY_TARGET),
    coverageLine: num(v.coverageLine, DEFAULT_COVERAGE_LINE),
    notesPeriod: typeof v.notesPeriod === 'string' ? v.notesPeriod : '',
    repNotes: notes,
  };
}

/**
 * The run this period's briefing is measured against: the previous period's run, or —
 * the first time a period is generated — the run currently on record.
 */
export function movementBaseline(meta: BriefingMeta, periodKey: string): BriefingRun {
  return meta.periodKey === periodKey ? meta.previous : meta.current;
}

/** The meta to persist when a briefing is generated for `periodKey`. */
export function recordRun(meta: BriefingMeta, periodKey: string, run: BriefingRun): BriefingMeta {
  const rolled = meta.periodKey === periodKey;
  return {
    ...meta,
    periodKey,
    current: run,
    previous: rolled ? meta.previous : meta.current,
    notesPeriod: meta.notesPeriod === periodKey ? meta.notesPeriod : periodKey,
    repNotes: meta.notesPeriod === periodKey ? meta.repNotes : {},
  };
}

/** The briefing period a date falls in: the Monday of its ISO week (YYYY-MM-DD). */
export function briefingPeriodKey(now: Date): string {
  return getISOWeekRange(now).start.toISOString().slice(0, 10);
}

/** This period's rep commentary — empty once the period rolls over, by design. */
export function repNotesForPeriod(meta: BriefingMeta, periodKey: string): Record<string, string> {
  return meta.notesPeriod === periodKey ? meta.repNotes : {};
}

/** An open deal: stage wins over a stale terminal classification, as in Deal Risk. */
export function isOpenDeal(o: Opportunity): boolean {
  return isOpenStage(o.stage);
}

export interface CohortInput {
  opportunities: Opportunity[];
  reps: Rep[];
  snapshots: OpportunitySnapshot[];
  involvement: InvolvementMap;
  monthKey: string;
  threshold: number;
  now: Date;
}

/**
 * The cohort: team-owned (evaluated now, not stamped), open, closing in `monthKey`, at or
 * above `threshold`. Sorted by amount descending — the order the manager reads them in.
 */
export function selectBigDeals({ opportunities, reps, snapshots, involvement, monthKey, threshold, now }: CohortInput): BigDealRow[] {
  const teamRepNames = buildTeamRepNameSet(reps);
  const rows: BigDealRow[] = [];
  for (const opp of opportunities) {
    if (!isTeamOwned(opp, teamRepNames)) continue;
    if (!isOpenDeal(opp)) continue;
    if (!opp.closeDate || getMonthKey(opp.closeDate) !== monthKey) continue;
    if ((opp.amount || 0) < threshold) continue;
    const key = involvementKey(opp);
    rows.push({
      opp,
      key,
      quoteState: reconcileQuote(opp).state,
      involvement: involvementFor(involvement, key),
      daysInStage: daysSinceStageChange(stageHistoryFor(opp, snapshots), opp, now),
    });
  }
  return rows.sort((a, b) => (b.opp.amount || 0) - (a.opp.amount || 0));
}

export function cohortTotal(rows: BigDealRow[]): number {
  return rows.reduce((s, r) => s + (r.opp.amount || 0), 0);
}

export function toCohortMember(row: BigDealRow): BriefingCohortMember {
  return {
    key: row.key,
    name: row.opp.name,
    rep: row.opp.repName,
    amount: row.opp.amount || 0,
    stage: row.opp.stage,
    closeDate: row.opp.closeDate,
  };
}

// ---- Movement since the previous briefing ----

export type DepartureKind = 'won' | 'lost' | 'pushed' | 'pulled_in' | 'below_threshold' | 'off_book';
export type ChangeKind = 'stage' | 'closeDate' | 'amount';

export interface Departure {
  kind: DepartureKind;
  member: BriefingCohortMember;
  detail: string;
  /** Current amount where it is still knowable, else the amount last seen in the cohort. */
  amount: number;
}

export interface DealChange {
  key: string;
  name: string;
  rep: string;
  amount: number;
  kind: ChangeKind;
  from: string;
  to: string;
}

export interface Movement {
  /** No previous briefing to measure against — the email says "baseline week". */
  baseline: boolean;
  /** Set when the previous briefing covered a different month/threshold selection. */
  selectionChanged: boolean;
  windowStart: string;
  departures: Departure[];
  changes: DealChange[];
}

const DEPARTURE_ORDER: Record<DepartureKind, number> = {
  won: 0, lost: 1, pushed: 2, pulled_in: 3, below_threshold: 4, off_book: 5,
};

const norm = (s: string | undefined) => (s || '').toLowerCase().trim();

/**
 * Why a deal that was in the cohort last briefing is not in it now, read off the deal's
 * current state. Closed Won leads the section: that is progress toward the path.
 */
function classifyDeparture(
  member: BriefingCohortMember,
  current: Opportunity | undefined,
  monthKey: string,
  threshold: number,
  teamRepNames: Set<string>,
): Departure {
  if (!current) {
    return { kind: 'off_book', member, amount: member.amount, detail: 'no longer in the imported book' };
  }
  const amount = current.amount || 0;
  const stage = norm(current.stage);
  if (stage === 'closed won' || current.classification === 'closed_won') {
    return { kind: 'won', member, amount, detail: `CLOSED WON ${fmtMoney(amount)}` };
  }
  if (stage === 'closed lost' || current.classification === 'lost') {
    const reason = current.lostReason ? ` — ${current.lostReason}` : '';
    return { kind: 'lost', member, amount, detail: `closed lost${reason}` };
  }
  if (stage === 'rejected' || current.classification === 'rejected') {
    return { kind: 'lost', member, amount, detail: 'rejected' };
  }
  if (!isTeamOwned(current, teamRepNames)) {
    return { kind: 'off_book', member, amount, detail: `owner is now ${current.repName || 'unassigned'} (off team)` };
  }
  const nowMonth = current.closeDate ? getMonthKey(current.closeDate) : '';
  if (nowMonth && nowMonth !== monthKey) {
    const kind: DepartureKind = nowMonth > monthKey ? 'pushed' : 'pulled_in';
    const verb = kind === 'pushed' ? 'pushed out of the month' : 'pulled into an earlier month';
    return { kind, member, amount, detail: `${verb} — close date ${fmtDate(member.closeDate)} → ${fmtDate(current.closeDate)}` };
  }
  if (amount < threshold) {
    return { kind: 'below_threshold', member, amount, detail: `dropped below ${fmtMoney(threshold)} — ${fmtMoney(member.amount)} → ${fmtMoney(amount)}` };
  }
  return { kind: 'off_book', member, amount, detail: 'no longer in the cohort' };
}

export interface MovementInput {
  rows: BigDealRow[];
  opportunities: Opportunity[];
  reps: Rep[];
  changelog: ChangeLogEntry[];
  /** The run this briefing is measured against — see movementBaseline. */
  baseline: BriefingRun;
  monthKey: string;
  threshold: number;
}

/**
 * What moved since the previous briefing.
 *
 * Field-level changes come from the import changelog — the same rows that back the stage
 * transitions table — collapsed to one first→last pair per deal and field, so a deal that
 * moved twice in the week reads as one move. Departures come from the cohort captured at
 * the last generation, compared against each deal's current state.
 */
export function computeMovement({ rows, opportunities, reps, changelog, baseline, monthKey, threshold }: MovementInput): Movement {
  const windowStart = baseline.generatedAt;
  const isBaselineWeek = !windowStart;
  const selectionChanged = !isBaselineWeek && (baseline.monthKey !== monthKey || baseline.threshold !== threshold);
  if (isBaselineWeek || selectionChanged) {
    return { baseline: isBaselineWeek, selectionChanged, windowStart, departures: [], changes: [] };
  }

  const teamRepNames = buildTeamRepNameSet(reps);
  const currentKeys = new Set(rows.map(r => r.key));
  const byKey = new Map<string, Opportunity>();
  for (const o of opportunities) {
    byKey.set(involvementKey(o), o);
    if (o.salesforceId) byKey.set(o.salesforceId, o);
  }

  const departures: Departure[] = [];
  for (const member of baseline.cohort) {
    if (currentKeys.has(member.key)) continue;
    departures.push(classifyDeparture(member, byKey.get(member.key), monthKey, threshold, teamRepNames));
  }
  departures.sort((a, b) => DEPARTURE_ORDER[a.kind] - DEPARTURE_ORDER[b.kind] || b.amount - a.amount);

  // Changelog rows are keyed by Salesforce id and stamped with the import that wrote them.
  const TRACKED: Record<string, ChangeKind> = { stage: 'stage', closeDate: 'closeDate', amount: 'amount' };
  const collapsed = new Map<string, DealChange>();
  const ordered = [...changelog].sort((a, b) => a.importDate.localeCompare(b.importDate));
  for (const entry of ordered) {
    const kind = TRACKED[entry.field];
    if (!kind) continue;
    if (entry.importDate <= windowStart) continue;
    if (!currentKeys.has(entry.opportunityId)) continue;
    const row = rows.find(r => r.key === entry.opportunityId);
    if (!row) continue;
    const id = `${entry.opportunityId}:${kind}`;
    const existing = collapsed.get(id);
    if (existing) existing.to = entry.newValue;
    else {
      collapsed.set(id, {
        key: entry.opportunityId,
        name: row.opp.name,
        rep: row.opp.repName,
        amount: row.opp.amount || 0,
        kind,
        from: entry.oldValue,
        to: entry.newValue,
      });
    }
  }
  // A deal that moved and moved back inside the window has not moved.
  const changes = Array.from(collapsed.values())
    .filter(c => c.from !== c.to)
    .sort((a, b) => b.amount - a.amount || a.kind.localeCompare(b.kind));

  return { baseline: isBaselineWeek, selectionChanged, windowStart, departures, changes };
}

// ---- Rep pipeline for the rest of the quarter ----

export interface RepPipelineRow {
  repName: string;
  /** Open, team-owned deals still carrying a close date inside the quarter. */
  openAmount: number;
  openCount: number;
  /** The rep's goal for the quarter, from the roster. 0 when unset. */
  goal: number;
  wonInQuarter: number;
  remainingGoal: number;
  /** openAmount ÷ remainingGoal. null when there is no goal to divide by. */
  coverage: number | null;
  /** Below the coverage line, with a goal to measure against. */
  thin: boolean;
  note: string;
}

export interface RepPipelineInput {
  opportunities: Opportunity[];
  reps: Rep[];
  quarter: Quarter;
  coverageLine: number;
  repNotes: Record<string, string>;
}

/**
 * Per team rep: what is still open with a close date in the quarter, against the part of
 * the goal still unmet. Past-dated open deals are included — they are still what the rep
 * has left to close — and inactive reps are dropped, matching the dashboard's rep table.
 */
export function buildRepPipeline({ opportunities, reps, quarter, coverageLine, repNotes }: RepPipelineInput): RepPipelineRow[] {
  const teamRepNames = buildTeamRepNameSet(reps);
  const qStart = quarterStart(quarter);
  const qEnd = quarterEnd(quarter);
  const inQuarter = (date: string | undefined) => {
    if (!date) return false;
    const t = new Date(date).getTime();
    return !isNaN(t) && t >= qStart.getTime() && t <= qEnd.getTime();
  };

  const names = new Set<string>();
  for (const r of reps) if (isTeamStatus(r) && r.isActive !== false) names.add(r.name);
  for (const o of opportunities) if (isTeamOwned(o, teamRepNames)) names.add(o.repName);
  const inactive = new Set(reps.filter(r => r.isActive === false).map(r => r.name));

  const out: RepPipelineRow[] = [];
  for (const repName of Array.from(names).filter(n => !inactive.has(n)).sort((a, b) => a.localeCompare(b))) {
    const rep = reps.find(r => r.name === repName);
    const mine = opportunities.filter(o => o.repName === repName && isTeamOwned(o, teamRepNames) && inQuarter(o.closeDate));
    const open = mine.filter(isOpenDeal);
    const openAmount = open.reduce((s, o) => s + (o.amount || 0), 0);
    const wonInQuarter = mine.filter(o => o.classification === 'closed_won').reduce((s, o) => s + (o.amount || 0), 0);
    const goal = rep?.quarterlyGoals?.[quarter] || 0;
    const remainingGoal = Math.max(0, goal - wonInQuarter);
    const coverage = remainingGoal > 0 ? openAmount / remainingGoal : null;
    out.push({
      repName,
      openAmount,
      openCount: open.length,
      goal,
      wonInQuarter,
      remainingGoal,
      coverage,
      thin: coverage !== null && coverage < coverageLine,
      note: repNotes[repName] || '',
    });
  }
  return out;
}

// ---- Formatting ----

export const fmtMoney = (n: number): string => `$${Math.round(n || 0).toLocaleString('en-US')}`;

/** Compact money for the header line: $1.11M, $840K. */
export function fmtCompactMoney(n: number): string {
  const v = Math.round(n || 0);
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2).replace(/0$/, '')}M`;
  if (Math.abs(v) >= 1_000) return `$${Math.round(v / 1000)}K`;
  return `$${v}`;
}

export function fmtDate(date: string | undefined): string {
  if (!date) return '—';
  const d = new Date(date);
  if (isNaN(d.getTime())) return String(date);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(date).trim());
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(dateOnly ? { timeZone: 'UTC' } : {}) });
}

export function monthName(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  if (!y || !m) return monthKey;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
}

function pad(text: string, width: number): string {
  const s = text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
  return s.padEnd(width);
}

/** Involvement rendered for the email: status plus the date it refers to. */
export function involvementLabel(e: InvolvementEntry): string {
  const base = INVOLVEMENT_META[e.status].short;
  return e.date ? `${base} ${fmtDate(e.date)}` : base;
}

// Footnote markers for the two amount flags.
const FOOTNOTES: Record<string, { marker: string; text: string }> = {
  'quoted-mismatch': { marker: '[1]', text: '[1] mismatch = Amount disagrees with quoted monthly (Amount ≠ Monthly × 12); one manual step was skipped, and neither value is authoritative.' },
  unquoted: { marker: '[2]', text: '[2] unquoted = registration estimate, no quote produced yet.' },
};

export interface BriefingInput {
  rows: BigDealRow[];
  movement: Movement;
  repRows: RepPipelineRow[];
  monthKey: string;
  quarter: Quarter;
  threshold: number;
  monthlyTarget: number;
  coverageLine: number;
  now: Date;
}

/**
 * The Friday briefing, as email-ready plain text.
 *
 * Every figure is read from the cohort and the movement window computed above, which are
 * the same objects the Big Deals table renders — the email cannot disagree with the screen.
 */
export function buildFridayBriefing({ rows, movement, repRows, monthKey, quarter, threshold, monthlyTarget, coverageLine, now }: BriefingInput): string {
  const lines: string[] = [];
  const total = cohortTotal(rows);
  const month = monthName(monthKey);
  const rule = '─'.repeat(60);

  lines.push(`Friday Briefing — ${month} big deals (${fmtMoney(threshold)}+)`);
  lines.push(`Generated ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`);
  lines.push(rule);
  lines.push('');

  // a. Header — progress toward the path.
  const gap = monthlyTarget - total;
  lines.push(
    `${rows.length} ${rows.length === 1 ? 'deal' : 'deals'}, ${fmtCompactMoney(total)} of the ${fmtCompactMoney(monthlyTarget)} ${month} path` +
    (gap > 0 ? ` — ${fmtCompactMoney(gap)} of open cohort still to find.` : gap < 0 ? ` — ${fmtCompactMoney(-gap)} above the path.` : '.'),
  );
  lines.push('');

  // b. Deal table.
  const used = new Set<string>();
  lines.push('OPEN DEALS');
  lines.push(rule);
  if (rows.length === 0) {
    lines.push(`  No open team deals closing in ${month} at ${fmtMoney(threshold)} or above.`);
  } else {
    lines.push(
      `  ${pad('Rep', 16)}${pad('Deal', 34)}${pad('Amount', 14)}${pad('Stage', 12)}${pad('Close', 8)}${pad('Manager', 20)}My role`,
    );
    for (const r of rows) {
      const fn = FOOTNOTES[r.quoteState];
      if (fn) used.add(r.quoteState);
      const amount = `${fmtMoney(r.opp.amount || 0)}${fn ? ` ${fn.marker}` : ''}`;
      lines.push(
        `  ${pad(r.opp.repName, 16)}${pad(r.opp.name, 34)}${pad(amount, 14)}${pad(r.opp.stage, 12)}${pad(fmtDate(r.opp.closeDate), 8)}${pad(involvementLabel(r.involvement), 20)}${r.involvement.note || '—'}`,
      );
    }
    const notIntroduced = rows.filter(r => r.involvement.status !== 'introduced');
    lines.push('');
    lines.push(
      `  Manager introduced on ${rows.length - notIntroduced.length} of ${rows.length}` +
      (notIntroduced.length > 0
        ? `; not yet on ${notIntroduced.map(r => r.opp.name).join(', ')}.`
        : '.'),
    );
    if (used.size > 0) {
      lines.push('');
      for (const state of ['quoted-mismatch', 'unquoted']) {
        if (used.has(state)) lines.push(`  ${FOOTNOTES[state].text}`);
      }
    }
  }
  lines.push('');

  // c. Movement since the last briefing.
  lines.push('MOVEMENT SINCE LAST BRIEFING');
  lines.push(rule);
  if (movement.baseline) {
    lines.push('  Baseline week — this is the first briefing, so there is nothing to compare against.');
    lines.push('  Next Friday reports movement against this list.');
  } else if (movement.selectionChanged) {
    lines.push(`  Baseline for this selection — the last briefing covered a different month or threshold.`);
  } else {
    const since = new Date(movement.windowStart);
    lines.push(`  Since ${since.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}.`);
    const won = movement.departures.filter(d => d.kind === 'won');
    const otherDepartures = movement.departures.filter(d => d.kind !== 'won');
    if (won.length > 0) {
      lines.push('');
      for (const d of won) lines.push(`  ✓ ${d.member.name} (${d.member.rep}) — ${d.detail}`);
      lines.push(`    Closed won out of the cohort this week: ${fmtMoney(won.reduce((s, d) => s + d.amount, 0))} across ${won.length}.`);
    }
    if (movement.changes.length > 0) {
      lines.push('');
      for (const c of movement.changes) {
        const label = c.kind === 'stage' ? 'stage' : c.kind === 'closeDate' ? 'close date' : 'amount';
        const from = c.kind === 'amount' ? fmtMoney(Number(c.from) || 0) : c.kind === 'closeDate' ? fmtDate(c.from) : c.from;
        const to = c.kind === 'amount' ? fmtMoney(Number(c.to) || 0) : c.kind === 'closeDate' ? fmtDate(c.to) : c.to;
        lines.push(`  · ${c.name} (${c.rep}) — ${label} ${from} → ${to}`);
      }
    }
    if (otherDepartures.length > 0) {
      lines.push('');
      lines.push('  Left the cohort:');
      for (const d of otherDepartures) lines.push(`  · ${d.member.name} (${d.member.rep}) — ${d.detail}`);
    }
    if (won.length === 0 && movement.changes.length === 0 && otherDepartures.length === 0) {
      lines.push('  No stage, close-date or amount movement on the cohort, and nothing left it.');
    }
  }
  lines.push('');

  // d. Rep section.
  lines.push(`PIPELINE BY REP — REST OF ${quarter.replace('-', ' ')}`);
  lines.push(rule);
  lines.push(`  Open pipeline still carrying a ${quarter} close date, against the goal not yet won. Coverage line ${coverageLine.toFixed(1)}x.`);
  lines.push('');
  for (const r of repRows) {
    const cov = r.coverage === null ? 'no goal set' : `${r.coverage.toFixed(1)}x vs ${fmtMoney(r.remainingGoal)} to go`;
    lines.push(`  ${pad(r.repName, 16)}${pad(`${fmtMoney(r.openAmount)} · ${r.openCount} open`, 26)}${cov}${r.thin ? '   ** below coverage line **' : ''}`);
    if (r.note) lines.push(`  ${' '.repeat(16)}${r.note}`);
  }
  const thin = repRows.filter(r => r.thin);
  if (thin.length > 0) {
    lines.push('');
    lines.push(`  Pipeline building required: ${thin.map(r => r.repName).join(', ')}.`);
  }

  return lines.join('\n');
}
