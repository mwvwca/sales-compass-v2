import type { DealRegistration } from '@/types/forecast';

/** Normalize a stage string: lowercase, collapse separators/whitespace. */
function normStage(stage: string | undefined | null): string {
  return (stage || '').toLowerCase().replace(/[-_/]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Terminal stages whose probability is structural, not earned. */
export function isTerminalStage(stage: string | undefined | null): boolean {
  const s = normStage(stage);
  return s === 'closed won' || s === 'closed lost' || s === 'rejected';
}

/** Open (non-terminal) and at-or-above 25% probability. */
export function isOpenSqlStage(stage: string | undefined | null, prob: number | undefined | null): boolean {
  return (prob ?? 0) >= 0.25 && !isTerminalStage(stage);
}

/**
 * Is this registration qualified RIGHT NOW (current snapshot)?
 * Use for "open qualified pipeline value" type metrics.
 */
export function currentlySql(d: Pick<DealRegistration, 'probability'>): boolean {
  return (d.probability ?? 0) >= 0.25;
}

/**
 * Did this registration EVER reach SQL at any point?
 * Only counts observed open qualified stages (>=25% AND non-terminal) or a sqlDate stamp.
 * Closed Won/Lost/Rejected probability is structural and must NOT qualify a deal here.
 */
export function everReachedSql(d: Pick<DealRegistration, 'sqlDate' | 'stageHistory'>): boolean {
  if (d.sqlDate) return true;
  return (d.stageHistory?.some(h => isOpenSqlStage(h.stage, h.probability))) ?? false;
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
