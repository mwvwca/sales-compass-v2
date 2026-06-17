import type { DealRegistration } from '@/types/forecast';

/**
 * Is this registration qualified RIGHT NOW (current snapshot)?
 * Use for "open qualified pipeline value" type metrics.
 */
export function currentlySql(d: Pick<DealRegistration, 'probability'>): boolean {
  return (d.probability ?? 0) >= 0.25;
}

/**
 * Did this registration EVER reach SQL (probability >= 25%) at any point?
 * Use for cohort conversion, SQL rate, win-rate-on-SQL'd deals.
 * Closed Lost zeroes out probability, so we must consult the permanent markers.
 */
export function everReachedSql(d: Pick<DealRegistration, 'probability' | 'sqlDate' | 'stageHistory'>): boolean {
  if (d.sqlDate) return true;
  if ((d.probability ?? 0) >= 0.25) return true;
  return (d.stageHistory?.some(h => (h.probability ?? 0) >= 0.25)) ?? false;
}

/**
 * Parse a YYYY-MM-DD string into a local Date (avoids UTC off-by-one),
 * falling back to Date constructor for other formats.
 */
function parseLocalYMD(s: string): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const t = new Date(s);
  return isNaN(t.getTime()) ? null : t;
}

/**
 * Days since the registration's last meaningful touch.
 * Uses lastActivity when present, otherwise createdDate.
 */
export function daysSinceActivity(
  d: Pick<DealRegistration, 'lastActivity' | 'createdDate'>,
  today: Date = new Date(),
): number {
  const ref = (d.lastActivity && d.lastActivity.trim()) ? d.lastActivity : d.createdDate;
  const refDate = ref ? parseLocalYMD(ref) : null;
  if (!refDate) return 0;
  return Math.max(0, Math.floor((today.getTime() - refDate.getTime()) / 86_400_000));
}
