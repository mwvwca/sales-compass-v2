/**
 * F2 fix: Salesforce exports Probability as 0-100 while the app stores 0-1.
 * The import path divided stage-derived probability by 100 but passed the raw
 * column value through untouched, so percent-scale values (5, 25, 50, 100)
 * leaked into storage alongside fraction-scale values. That broke the 25% SQL
 * gate (5 >= 0.25 passes for a 5% deal) and the Deal 360 display (25 renders
 * as 2500%).
 *
 * Rule: any probability above 1 is treated as a percentage and divided by 100.
 * Applied at import, at load/hydration (migrates stored records), and on
 * backup restore.
 */
export function normalizeProbability(p: unknown): number {
  const n = typeof p === 'number' && isFinite(p) ? p : parseFloat(String(p ?? ''));
  if (!isFinite(n) || n <= 0) return 0;
  const scaled = n > 1 ? n / 100 : n;
  return Math.min(1, scaled);
}
