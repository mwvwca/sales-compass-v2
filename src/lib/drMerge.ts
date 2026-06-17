import type {
  DealRegistration,
  RawDrRecord,
  Opportunity,
  DrStatus,
} from '@/types/forecast';
import { getQuarter } from '@/types/forecast';
import { parseExcelDate } from './drParser';
import { currentlySql, daysSinceActivity } from './drSql';

export interface DrBatchStats {
  newCount: number;
  updatedCount: number;
  rejectedCount: number;
  withdrawnCount: number;
  convertedCount: number;
}

const PRE_SQL_PROB = 0.25;
const STALE_DAYS = 15;

function isRejectedStage(stage: string): boolean {
  return (stage || '').toLowerCase().trim() === 'rejected';
}

/** Stale = not rejected, not currently SQL, no activity for STALE_DAYS+. */
function isStaleFor(d: DealRegistration, today: Date): boolean {
  if (isRejectedStage(d.stage)) return false;
  if (currentlySql(d)) return false;
  return daysSinceActivity(d, today) >= STALE_DAYS;
}

function classifyByPipeline(opp: Opportunity | undefined): { status: DrStatus } | null {
  if (!opp) return null;
  const stageNorm = (opp.stage || '').toLowerCase().replace(/[-_/]/g, ' ').replace(/\s+/g, ' ').trim();
  if (stageNorm === 'closed won') return { status: 'closed_won' };
  if (stageNorm === 'closed lost') return { status: 'closed_lost' };
  return { status: 'converted' };
}

/** Compute closedWonDate / cycleDays / inPeriodWon for a DR matched to a closed won opp. */
function computeCycleFields(
  dr: { createdDate: string },
  opp: Opportunity | undefined
): Pick<DealRegistration, 'closedWonDate' | 'cycleDays' | 'inPeriodWon'> {
  if (!opp?.closeDate || !dr.createdDate) {
    return { cycleDays: undefined, closedWonDate: undefined, inPeriodWon: undefined };
  }

  // Both dates should already be YYYY-MM-DD strings after import parsing
  // Use direct string parsing to avoid any re-parsing issues
  const parseYMD = (s: string): Date | null => {
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (us) return new Date(Date.UTC(+us[3], +us[1] - 1, +us[2]));
    const parsed = parseExcelDate(s);
    if (parsed) return new Date(parsed);
    return null;
  };

  const created = parseYMD(dr.createdDate);
  const closed = parseYMD(opp.closeDate);

  if (!created || !closed) {
    console.warn('computeCycleFields: failed to parse dates', { createdDate: dr.createdDate, closeDate: opp.closeDate });
    return { cycleDays: undefined, closedWonDate: opp.closeDate, inPeriodWon: undefined };
  }

  const cycleDays = Math.max(0, Math.floor((closed.getTime() - created.getTime()) / 86_400_000));

  let inPeriodWon = false;
  try {
    inPeriodWon = getQuarter(dr.createdDate) === getQuarter(opp.closeDate);
  } catch { /* noop */ }

  return { closedWonDate: opp.closeDate, cycleDays, inPeriodWon };
}


/** Returns whether mutable fields differ between an existing record and incoming raw record. */
function hasFieldChanges(existing: DealRegistration, incoming: RawDrRecord): boolean {
  const fields: Array<keyof RawDrRecord> = [
    'opportunityName', 'accountName', 'repName', 'secondOwner', 'channelAccountManager',
    'resellerName', 'distributorReseller', 'resolvedReseller', 'product', 'stage', 'probability', 'amount',
    'expectedRevenue', 'closeDate', 'billingState', 'leadSource', 'type', 'registeredDeal',
    'lastActivity', 'ageDays',
  ];
  for (const f of fields) {
    const a = existing[f as keyof DealRegistration];
    const b = incoming[f];
    if ((a ?? null) !== (b ?? null)) return true;
  }
  return false;
}

export function mergeDrBatch(
  existing: DealRegistration[],
  incoming: RawDrRecord[],
  opportunities: Opportunity[],
  batchId: string,
  importedAt: string,
): { merged: DealRegistration[]; stats: DrBatchStats } {
  const existingMap = new Map(existing.map(d => [d.opportunityId, d]));
  const incomingMap = new Map(incoming.map(d => [d.opportunityId, d]));
  const oppMap = new Map(
    opportunities
      .filter(o => o.salesforceId)
      .map(o => [o.salesforceId!, o])
  );

  let newCount = 0;
  let updatedCount = 0;
  let rejectedCount = 0;
  let withdrawnCount = 0;
  let convertedCount = 0;

  const merged: DealRegistration[] = [];

  // Step 1: process incoming records (new + updates)
  for (const inc of incoming) {
    const prev = existingMap.get(inc.opportunityId);
    const isSql = inc.probability >= PRE_SQL_PROB;

    if (!prev) {
      newCount++;
      const rec: DealRegistration = {
        ...inc,
        batchIdFirstSeen: batchId,
        firstSeenAt: importedAt,
        lastSeenAt: importedAt,
        lastUpdatedAt: importedAt,
        stageHistory: [{
          stage: inc.stage,
          probability: inc.probability,
          date: importedAt.slice(0, 10),
          batchId,
        }],
        isSql,
        sqlDate: isSql ? importedAt.slice(0, 10) : undefined,
        status: 'active',
      };
      merged.push(rec);
    } else {
      const changed = hasFieldChanges(prev, inc);
      if (changed) updatedCount++;

      const stageChanged = prev.stage !== inc.stage || prev.probability !== inc.probability;
      const stageHistory = stageChanged
        ? [...(prev.stageHistory ?? []), { stage: inc.stage, probability: inc.probability, date: importedAt.slice(0, 10), batchId }]
        : (prev.stageHistory ?? []);

      // sqlDate is PERMANENT once set — never wipe it (the deal qualified at least once).
      const sqlDate = prev.sqlDate ?? (isSql ? importedAt.slice(0, 10) : undefined);

      const rec: DealRegistration = {
        ...prev,
        opportunityName: inc.opportunityName,
        accountName: inc.accountName,
        repName: inc.repName,
        secondOwner: inc.secondOwner,
        channelAccountManager: inc.channelAccountManager,
        resellerName: inc.resellerName,
        distributorReseller: inc.distributorReseller,
        resolvedReseller: inc.resolvedReseller,
        product: inc.product,
        stage: inc.stage,
        probability: inc.probability,
        amount: inc.amount,
        expectedRevenue: inc.expectedRevenue,
        closeDate: inc.closeDate,
        billingState: inc.billingState,
        leadSource: inc.leadSource,
        type: inc.type,
        registeredDeal: inc.registeredDeal,
        lastActivity: inc.lastActivity,
        ageDays: inc.ageDays,
        accountUrl: inc.accountUrl ?? prev.accountUrl,
        lastSeenAt: importedAt,
        lastUpdatedAt: changed ? importedAt : prev.lastUpdatedAt,
        stageHistory,
        isSql,
        sqlDate,
        status: prev.status,
        convertedAt: prev.convertedAt,
        rejectedAt: prev.rejectedAt,
      };
      merged.push(rec);
    }
  }

  // Step 2: existing records NOT in incoming → withdrawn or converted (pipeline match)
  for (const prev of existing) {
    if (incomingMap.has(prev.opportunityId)) continue;
    const opp = oppMap.get(prev.opportunityId);
    const pipelineClass = classifyByPipeline(opp);

    if (pipelineClass) {
      const isFirstConversion = !prev.convertedAt;
      if (isFirstConversion) convertedCount++;
      const cycle = pipelineClass.status === 'closed_won' ? computeCycleFields(prev, opp) : {};
      merged.push({
        ...prev,
        status: pipelineClass.status,
        convertedAt: prev.convertedAt || importedAt,
        ...cycle,
      });
    } else {
      const isNewlyWithdrawn = prev.status !== 'withdrawn';
      if (isNewlyWithdrawn) withdrawnCount++;
      merged.push({
        ...prev,
        status: 'withdrawn',
        rejectedAt: prev.rejectedAt || importedAt,
      });
    }
  }

  // Step 3: recompute status for records still present in incoming
  const presentRecs = merged.filter(r => incomingMap.has(r.opportunityId));

  // Padded grouping (excludes rejected)
  const byAcctCam = new Map<string, DealRegistration[]>();
  for (const r of presentRecs) {
    if (isRejectedStage(r.stage)) continue;
    const k = `${(r.accountName || '(none)').toLowerCase()}||${(r.channelAccountManager || '(none)').toLowerCase()}`;
    const arr = byAcctCam.get(k) || [];
    arr.push(r);
    byAcctCam.set(k, arr);
  }

  for (let i = 0; i < merged.length; i++) {
    const r = merged[i];
    if (!incomingMap.has(r.opportunityId)) continue;

    // 1) AE-rejected wins above everything
    if (isRejectedStage(r.stage)) {
      const isFirstReject = r.status !== 'rejected';
      if (isFirstReject) rejectedCount++;
      merged[i] = { ...r, status: 'rejected', rejectedAt: r.rejectedAt || importedAt };
      continue;
    }

    // 2) Pipeline match
    const opp = oppMap.get(r.opportunityId);
    const pipelineClass = classifyByPipeline(opp);
    if (pipelineClass) {
      const isFirstConversion = !r.convertedAt;
      if (isFirstConversion) convertedCount++;
      const cycle = pipelineClass.status === 'closed_won' ? computeCycleFields(r, opp) : {};
      merged[i] = {
        ...r,
        status: pipelineClass.status,
        convertedAt: r.convertedAt || importedAt,
        ...cycle,
      };
      continue;
    }

    // 3) SQL
    if (r.isSql) {
      merged[i] = { ...r, status: 'sql' };
      continue;
    }

    // 4) Padded
    const k = `${(r.accountName || '(none)').toLowerCase()}||${(r.channelAccountManager || '(none)').toLowerCase()}`;
    const group = byAcctCam.get(k) || [];
    const preSqlInGroup = group.filter(x => !x.isSql);
    if (preSqlInGroup.length >= 2 && !r.lastActivity) {
      merged[i] = { ...r, status: 'padded' };
      continue;
    }

    // 5) Stale
    if (isStaleFor(r)) {
      merged[i] = { ...r, status: 'stale' };
      continue;
    }

    // 6) Active
    merged[i] = { ...r, status: 'active' };
  }

  console.log(`[drMerge] After merge: ${merged.filter(d => d.accountUrl).length} of ${merged.length} records have accountUrl`);
  return { merged, stats: { newCount, updatedCount, rejectedCount, withdrawnCount, convertedCount } };
}
