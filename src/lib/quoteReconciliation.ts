import type { Opportunity, OpportunitySnapshot } from '@/types/forecast';

/**
 * Amount vs Amount (Monthly) reconciliation.
 *
 * Salesforce is supposed to hold ACV in `Amount`, but it auto-overwrites `Amount`
 * with TCV whenever a quote is built or re-run — including when an AE merely edits
 * a contract start date. The AE then has to manually reset `Amount` back to ACV and
 * manually update `Amount (Monthly)`. They frequently skip one or both steps.
 *
 * Consequence: when `Monthly × 12` and `Amount` disagree, a manual step was skipped.
 * That is ALL the disagreement tells us. It does NOT identify which field is wrong,
 * so nothing here labels either value as correct, and `Monthly × 12` is never
 * substituted for `Amount` in any display or total — this module reports, it does
 * not repair.
 *
 * A blank or zero Monthly means no quote has ever been produced, so `Amount` is a
 * registration-time estimate. That is a neutral state, not an error.
 */

/** Absolute floor on the Monthly-vs-Amount/12 gap before it counts as a disagreement. */
export const QUOTE_TOLERANCE_ABS = 0.02;
/** Relative floor, as a fraction of Amount/12. Both floors must be exceeded. */
export const QUOTE_TOLERANCE_PCT = 0.005;

export type QuoteState =
  /** Monthly × 12 agrees with Amount within tolerance. */
  | 'quoted-clean'
  /** Monthly × 12 and Amount disagree — a manual step was skipped, field unknown. */
  | 'quoted-mismatch'
  /** No quote has ever run: Monthly blank/zero, Amount is a registration estimate. */
  | 'unquoted'
  /** Neither field is usable — nothing to say. */
  | 'unknown';

export interface QuoteReconciliation {
  state: QuoteState;
  /** Amount as stored (ACV in the happy path, TCV after an un-reset re-quote). */
  amount: number | null;
  /** Amount (Monthly) as stored. */
  amountMonthly: number | null;
  /** amount / 12 — the monthly figure Amount implies. Display only. */
  amountPerMonth: number | null;
  /** amountMonthly × 12 — the annual figure Monthly implies. Display only, never a substitute for Amount. */
  monthlyAnnualized: number | null;
  /** amount / amountMonthly — how many monthly periods Amount covers. */
  impliedDivisor: number | null;
  /** Non-authoritative narrative read of the divisor. Never feeds severity or rollups. */
  likelyCause: string | null;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && isFinite(v) ? v : null;

/**
 * Human-readable divisor, e.g. "3.0" or "0.08".
 *
 * One decimal per spec, except below 1.0 where one decimal collapses every inverted
 * case into "0.1" and hides the magnitude; those get two decimals so the reader can
 * see how far inverted the pair is.
 */
export function formatDivisor(divisor: number): string {
  return divisor < 1 ? divisor.toFixed(2) : divisor.toFixed(1);
}

/**
 * Narrative hint only — a guess at which manual step was skipped, derived purely from
 * the divisor. It is deliberately hedged ("may"), is never used to set severity, and
 * never contributes to any rollup. When the divisor is uninformative it returns null.
 *
 * Bands, from the observed export:
 *  - < 1     Monthly exceeds Amount outright — the two values look transposed.
 *  - 1–11    Amount is well under the 12× an annual figure implies: a partial-term
 *            Amount, or a "Monthly" that is not actually a monthly figure. (The
 *            2026-08-31 export has real cases at 3.0 and 1.2, so this band is load
 *            bearing — it is NOT a TCV read; a 36-month TCV would sit at 36.0.)
 *  - 11–13   Near-miss around 12: most consistent with a stale Monthly left behind
 *            by a prior quote.
 *  - 13–60   Amount looks like TCV over a multi-month term; when the divisor is
 *            within 0.5 of an integer the term is named.
 *  - > 60    Beyond any plausible contract term.
 */
export function likelyCauseHint(divisor: number | null, amount: number | null): string | null {
  if (amount === null || amount === 0) {
    return 'Amount is blank or zero while a Monthly value exists — Amount may never have been set';
  }
  if (divisor === null || !isFinite(divisor)) return null;

  if (divisor < 1) {
    return 'fields may be inverted — Monthly is larger than Amount';
  }
  if (divisor < 11) {
    return `Amount covers only ~${formatDivisor(divisor)}× Monthly, far under the 12× an annual Amount implies — Amount may hold a partial-term value, or Monthly may not be a true monthly figure`;
  }
  if (divisor <= 13) {
    return 'Monthly may be stale from a prior quote — the pair is close to 12× but not equal';
  }
  if (divisor <= 60) {
    const nearest = Math.round(divisor);
    return Math.abs(divisor - nearest) <= 0.5
      ? `Amount may be TCV (approx ${nearest}-month term)`
      : `Amount may be TCV (implied term ≈ ${formatDivisor(divisor)} months)`;
  }
  return `Amount is ${formatDivisor(divisor)}× Monthly, beyond any plausible contract term`;
}

/**
 * Classify one deal's Amount / Amount (Monthly) pair.
 *
 * A disagreement is a reconciliation signal, not a verdict: the caller must present
 * both values as disagreeing and must not treat either as authoritative.
 */
export function reconcileQuote(
  opp: Pick<Opportunity, 'amount' | 'amountMonthly'>,
): QuoteReconciliation {
  const amount = num(opp.amount);
  const amountMonthly = num(opp.amountMonthly);

  const amountPerMonth = amount === null ? null : amount / 12;
  const monthlyAnnualized = amountMonthly === null ? null : amountMonthly * 12;

  // No quote has ever produced a Monthly value; Amount stands as a registration estimate.
  if (amountMonthly === null || amountMonthly === 0) {
    return {
      state: amount !== null && amount !== 0 ? 'unquoted' : 'unknown',
      amount, amountMonthly, amountPerMonth, monthlyAnnualized,
      impliedDivisor: null, likelyCause: null,
    };
  }

  const expected = amountPerMonth ?? 0;
  const gap = Math.abs(amountMonthly - expected);
  // Both floors must be exceeded — a rounding-scale gap on a huge deal is not a signal,
  // and neither is a large relative gap on a near-zero one.
  const mismatch = gap > QUOTE_TOLERANCE_ABS && gap > Math.abs(expected) * QUOTE_TOLERANCE_PCT;

  const impliedDivisor = amount === null ? null : amount / amountMonthly;

  return {
    state: mismatch ? 'quoted-mismatch' : 'quoted-clean',
    amount, amountMonthly, amountPerMonth, monthlyAnnualized, impliedDivisor,
    likelyCause: mismatch ? likelyCauseHint(impliedDivisor, amount) : null,
  };
}

export interface QuoteDrift {
  /** Which field moved most recently while the other held. */
  moved: 'amount' | 'monthly';
  /** ISO importDate of that move. */
  at: string;
  /** Ready-to-render sentence. */
  note: string;
}

type QuoteSnap = Pick<OpportunitySnapshot, 'importDate' | 'amount' | 'amountMonthly'>;

/** importDate of the last observed change in a series, or null when nothing changed. */
function lastChangeAt(series: { importDate: string; value: number | null }[]): string | null {
  for (let i = series.length - 1; i >= 1; i--) {
    if (series[i].value !== series[i - 1].value) return series[i].importDate;
  }
  return null;
}

const fmtDate = (iso: string): string => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  // A bare 'YYYY-MM-DD' parses as UTC midnight, so rendering it in a negative-offset
  // local zone would show the previous day. Date-only values are rendered in UTC; full
  // timestamps (what importDate actually carries) keep the reader's local day.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso.trim());
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    ...(dateOnly ? { timeZone: 'UTC' } : {}),
  });
};

/**
 * Which of the two fields moved last across import history — the observable trace of a
 * re-quote whose manual follow-up was skipped.
 *
 * Amount has been snapshotted since the snapshot machinery existed, so its history is
 * available immediately. Monthly is newly snapshotted, so its history accrues from the
 * first import after this change ships; until at least two snapshots actually carry a
 * Monthly value, Monthly is unobservable and this returns null rather than claiming
 * "Monthly held" from an absence of data. There is no retroactive backfill.
 *
 * `history` must be chronologically ascending (as `stageHistoryFor` returns).
 */
export function quoteDrift(history: QuoteSnap[]): QuoteDrift | null {
  const amountSeries = history
    .filter(s => num(s.amount) !== null)
    .map(s => ({ importDate: s.importDate, value: num(s.amount) }));
  // Only snapshots that actually carry the field count as observations of it.
  const monthlySeries = history
    .filter(s => s.amountMonthly !== undefined)
    .map(s => ({ importDate: s.importDate, value: num(s.amountMonthly) }));

  // Two observations are the minimum needed to say a field either moved or held.
  const amountObservable = amountSeries.length >= 2;
  const monthlyObservable = monthlySeries.length >= 2;
  if (!amountObservable || !monthlyObservable) return null;

  const amountAt = lastChangeAt(amountSeries);
  const monthlyAt = lastChangeAt(monthlySeries);

  if (amountAt && (!monthlyAt || amountAt > monthlyAt)) {
    return {
      moved: 'amount',
      at: amountAt,
      note: `Amount changed on ${fmtDate(amountAt)} without a Monthly update, likely re-quote with manual steps skipped.`,
    };
  }
  if (monthlyAt && (!amountAt || monthlyAt > amountAt)) {
    return {
      moved: 'monthly',
      at: monthlyAt,
      note: `Monthly changed on ${fmtDate(monthlyAt)} without an Amount update, likely re-quote with manual steps skipped.`,
    };
  }
  // Neither moved, or both moved in the same import — nothing distinguishable to report.
  return null;
}

/** Badge copy + tone for each quote state. `unquoted` is neutral, never an error. */
export const QUOTE_STATE_BADGE: Record<Exclude<QuoteState, 'unknown'>, { label: string; tone: string }> = {
  'quoted-mismatch': { label: 'Amount/Monthly disagree', tone: 'bg-red-500/15 text-red-700 dark:text-red-400' },
  'quoted-clean': { label: 'Quoted', tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' },
  'unquoted': { label: 'Unquoted (est.)', tone: 'bg-secondary/40 text-muted-foreground' },
};
