import { getQuarter, type Quarter, type ChangeLogEntry, type Opportunity } from '@/types/forecast';

export type SlipReason = 'date_pushed' | 'classification_dropped';

export interface SlipRecord {
  opportunityId: string;
  opportunityName: string;
  repName: string;
  channelAccountManager?: string;
  accountName?: string;
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
  classificationHistory: { from: string; to: string; date: string }[];
  closeDateHistory: { from: string; to: string; date: string }[];
  isNowClosed: boolean;
  isNowLost: boolean;
  isStillOpen: boolean;
}

export function quarterIndex(q: Quarter): number {
  const [y, qq] = q.split('-Q').map(Number);
  return y * 4 + (qq - 1);
}

/**
 * Deals that slipped out of `selectedQuarter` — either their close date was
 * pushed to a later quarter, or they dropped from commit/upside to a non-forecast
 * classification within the quarter. Pure over (opps, changelog, selectedQuarter).
 * Each record carries closeDateHistory and quartersPushed for downstream consumers.
 */
export function computeSlips(
  opps: Opportunity[],
  changelog: ChangeLogEntry[],
  selectedQuarter: Quarter,
): SlipRecord[] {
  const byOpp = new Map<string, ChangeLogEntry[]>();
  for (const e of changelog) {
    if (!byOpp.has(e.opportunityId)) byOpp.set(e.opportunityId, []);
    byOpp.get(e.opportunityId)!.push(e);
  }
  for (const arr of byOpp.values()) arr.sort((a, b) => a.importDate.localeCompare(b.importDate));

  const records: SlipRecord[] = [];
  for (const opp of opps) {
    if (opp.classification === 'rejected') continue;
    const entries = byOpp.get(opp.id) || [];
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

    const originalCloseDate = datePushHit?.oldValue || opp.closeDate;
    const originalQuarter: Quarter = datePushHit ? getQuarter(datePushHit.oldValue) : selectedQuarter;
    const currentCloseDate = opp.closeDate;
    const currentQuarter: Quarter = opp.closeDate ? getQuarter(opp.closeDate) : selectedQuarter;
    const quartersPushed = datePushHit
      ? Math.max(0, quarterIndex(currentQuarter) - quarterIndex(originalQuarter))
      : 0;

    records.push({
      opportunityId: opp.id,
      opportunityName: opp.name,
      repName: opp.repName,
      channelAccountManager: opp.channelAccountManager,
      accountName: opp.accountName,
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
      classificationHistory: classChanges.map(e => ({ from: e.oldValue, to: e.newValue, date: e.importDate })),
      closeDateHistory: dateChanges.map(e => ({ from: e.oldValue, to: e.newValue, date: e.importDate })),
      isNowClosed: opp.classification === 'closed_won',
      isNowLost: opp.classification === 'lost',
      isStillOpen: !['closed_won', 'lost', 'omitted', 'rejected'].includes(opp.classification),
    });
  }
  return records;
}
