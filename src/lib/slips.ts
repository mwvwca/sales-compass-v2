import { getQuarter, type Quarter, type ChangeLogEntry, type Opportunity, type OpportunitySnapshot } from '@/types/forecast';
import { rowsForOpportunity } from './historyKey';
import { isOpenStage } from './forecastClassification';
import { STALE_DAYS } from './dealRisk';

export type SlipReason = 'date_pushed' | 'classification_dropped';

export type SuggestedAction = 'Confirm new date' | 'Reforecast' | 'Review for disqualification';

export interface SlipRecord {
  opportunityId: string;
  opportunityName: string;
  repName: string;
  channelAccountManager?: string;
  accountName?: string;
  resolvedReseller?: string;
  productName?: string;
  amount: number;
  originalCloseDate: string;
  originalQuarter: Quarter;
  currentCloseDate: string;
  currentQuarter: Quarter;
  currentClassification: string;
  currentStage: string;
  slipReasons: SlipReason[];
  classDropFrom?: 'commit' | 'upside';
  quartersPushed: number;
  /** currentCloseDate − originalCloseDate, in days (≥ 0). */
  totalSlipDays: number;
  /** Distinct times the close date moved OUTWARD (new date later than old). */
  outwardMoveCount: number;
  /** Current close date falls in a later fiscal period (quarter) than the original. */
  crossesToLaterPeriod: boolean;
  /** Days since the last AE activity (falls back to last changelog movement); null if unknown. */
  daysSinceActivity: number | null;
  /** Data-derived recommended action. */
  suggestedAction: SuggestedAction;
  classificationHistory: { from: string; to: string; date: string }[];
  closeDateHistory: { from: string; to: string; date: string }[];
  /** STAGE-STRICT open check (reuses isOpenStage) — the actionable filter. */
  isOpen: boolean;
  isNowClosed: boolean;
  isNowLost: boolean;
  isStillOpen: boolean;
}

export function quarterIndex(q: Quarter): number {
  const [y, qq] = q.split('-Q').map(Number);
  return y * 4 + (qq - 1);
}

const dayMs = 86_400_000;
const daysBetween = (fromISO: string | undefined, to: Date): number | null => {
  if (!fromISO) return null;
  const t = Date.parse(fromISO);
  if (isNaN(t)) return null;
  return Math.floor((to.getTime() - t) / dayMs);
};

/**
 * Deals that slipped out of `selectedQuarter` — either their close date was
 * pushed to a later quarter, or they dropped from commit/upside to a non-forecast
 * classification within the quarter. Pure over (opps, changelog, snapshots, selectedQuarter).
 * Original close date is the earliest observed value across snapshot + changelog history.
 */
export function computeSlips(
  opps: Opportunity[],
  changelog: ChangeLogEntry[],
  snapshots: OpportunitySnapshot[],
  selectedQuarter: Quarter,
  today: Date = new Date(),
): SlipRecord[] {
  const byOpp = new Map<string, ChangeLogEntry[]>();
  for (const e of changelog) {
    if (!byOpp.has(e.opportunityId)) byOpp.set(e.opportunityId, []);
    byOpp.get(e.opportunityId)!.push(e);
  }
  for (const arr of byOpp.values()) arr.sort((a, b) => a.importDate.localeCompare(b.importDate));

  // Snapshots keyed by history id (salesforceId), earliest first — for the earliest observed close date.
  const snapsByOpp = new Map<string, OpportunitySnapshot[]>();
  for (const s of snapshots) {
    if (!snapsByOpp.has(s.opportunityId)) snapsByOpp.set(s.opportunityId, []);
    snapsByOpp.get(s.opportunityId)!.push(s);
  }
  for (const arr of snapsByOpp.values()) arr.sort((a, b) => (a.importDate || '').localeCompare(b.importDate || ''));

  const records: SlipRecord[] = [];
  for (const opp of opps) {
    if (opp.classification === 'rejected') continue;
    const entries = rowsForOpportunity(byOpp, opp);
    const dateChanges = entries.filter(e => e.field === 'closeDate' && e.oldValue && e.newValue);
    const classChanges = entries.filter(e => e.field === 'classification');

    // Condition A: original quarter (oldValue) == selectedQuarter AND newValue quarter > selectedQuarter
    let datePushHit: ChangeLogEntry | null = null;
    for (const e of dateChanges) {
      try {
        const oldQ = getQuarter(e.oldValue);
        const newQ = getQuarter(e.newValue);
        if (oldQ === selectedQuarter && quarterIndex(newQ) > quarterIndex(oldQ)) {
          datePushHit = e;
          break;
        }
      } catch { /* skip */ }
    }

    // Condition B: classification drop in selectedQuarter
    const drop = new Set(['unclassified', 'lost', 'omitted']);
    const from = new Set(['commit', 'upside']);
    let classDropHit: ChangeLogEntry | null = null;
    for (const e of classChanges) {
      if (from.has(e.oldValue) && drop.has(e.newValue) && getQuarter(e.importDate) === selectedQuarter) {
        classDropHit = e;
        break;
      }
    }

    if (!datePushHit && !classDropHit) continue;

    const reasons: SlipReason[] = [];
    if (datePushHit) reasons.push('date_pushed');
    if (classDropHit) reasons.push('classification_dropped');

    // Earliest observed close date: earliest snapshot value, else the first changelog
    // oldValue, else the qualifying push's oldValue, else the current close date.
    const oppSnaps = snapsByOpp.get(opp.salesforceId ?? '') ?? snapsByOpp.get(opp.id) ?? [];
    const earliestSnapClose = oppSnaps.find(s => s.closeDate)?.closeDate;
    const earliestChangeClose = dateChanges[0]?.oldValue;
    const originalCloseDate = earliestSnapClose || earliestChangeClose || datePushHit?.oldValue || opp.closeDate;
    let originalQuarter: Quarter = selectedQuarter;
    try { originalQuarter = getQuarter(originalCloseDate); } catch { /* keep selected */ }
    const currentCloseDate = opp.closeDate;
    const currentQuarter: Quarter = currentCloseDate ? getQuarter(currentCloseDate) : selectedQuarter;
    const quartersPushed = Math.max(0, quarterIndex(currentQuarter) - quarterIndex(originalQuarter));
    const crossesToLaterPeriod = quarterIndex(currentQuarter) > quarterIndex(originalQuarter);

    // Total slip in days (≥ 0) between original and current close date.
    const o = Date.parse(originalCloseDate), c = Date.parse(currentCloseDate);
    const totalSlipDays = !isNaN(o) && !isNaN(c) ? Math.max(0, Math.round((c - o) / dayMs)) : 0;

    // Distinct times the close date moved OUTWARD (new later than old).
    let outwardMoveCount = 0;
    for (const e of dateChanges) {
      const eo = Date.parse(e.oldValue), en = Date.parse(e.newValue);
      if (!isNaN(eo) && !isNaN(en) && en > eo) outwardMoveCount++;
    }

    // Days since activity: AE lastActivity, else last changelog movement.
    const lastMovement = entries.length ? entries[entries.length - 1].importDate : undefined;
    const daysSinceActivity = daysBetween(opp.lastActivity, today) ?? daysBetween(lastMovement, today);

    // Suggested action, derived: disqualification wins, then reforecast, then confirm.
    const stale = daysSinceActivity != null && daysSinceActivity >= STALE_DAYS;
    const suggestedAction: SuggestedAction =
      outwardMoveCount >= 3 || stale ? 'Review for disqualification'
      : crossesToLaterPeriod ? 'Reforecast'
      : 'Confirm new date';

    records.push({
      opportunityId: opp.id,
      opportunityName: opp.name,
      repName: opp.repName,
      channelAccountManager: opp.channelAccountManager,
      accountName: opp.accountName,
      resolvedReseller: opp.resolvedReseller || opp.resellerName,
      productName: opp.productName,
      amount: opp.amount,
      originalCloseDate,
      originalQuarter,
      currentCloseDate,
      currentQuarter,
      currentClassification: opp.classification,
      currentStage: opp.stage,
      slipReasons: reasons,
      classDropFrom: classDropHit ? (classDropHit.oldValue as 'commit' | 'upside') : undefined,
      quartersPushed,
      totalSlipDays,
      outwardMoveCount,
      crossesToLaterPeriod,
      daysSinceActivity,
      suggestedAction,
      classificationHistory: classChanges.map(e => ({ from: e.oldValue, to: e.newValue, date: e.importDate })),
      closeDateHistory: dateChanges.map(e => ({ from: e.oldValue, to: e.newValue, date: e.importDate })),
      isOpen: isOpenStage(opp.stage),
      isNowClosed: opp.classification === 'closed_won',
      isNowLost: opp.classification === 'lost',
      isStillOpen: !['closed_won', 'lost', 'omitted', 'rejected'].includes(opp.classification),
    });
  }
  return records;
}
