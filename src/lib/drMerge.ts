import type {
  DealRegistration,
  RawDrRecord,
  Opportunity,
  DrStatus,
  DrStageHistoryEntry,
} from '@/types/forecast';

export interface DrBatchStats {
  newCount: number;
  updatedCount: number;
  rejectedCount: number;
  convertedCount: number;
}

const PRE_SQL_PROB = 0.25;

function isStaleFor(d: { stage: string; probability: number; ageDays: number; lastActivity?: string }): boolean {
  const stage = (d.stage || '').toLowerCase();
  const age = d.ageDays;
  if (stage.includes('unqualified') && age > 21) return true;
  if (d.probability < 0.1 && age > 30) return true;
  if (d.probability >= PRE_SQL_PROB && age > 45 && !d.lastActivity) return true;
  return false;
}

function classifyByPipeline(opp: Opportunity | undefined): { status: DrStatus; isConverted: boolean } | null {
  if (!opp) return null;
  const stageNorm = (opp.stage || '').toLowerCase().replace(/[-_/]/g, ' ').replace(/\s+/g, ' ').trim();
  if (stageNorm === 'closed won') return { status: 'closed_won', isConverted: true };
  if (stageNorm === 'closed lost') return { status: 'closed_lost', isConverted: true };
  return { status: 'converted', isConverted: true };
}

/** Returns whether mutable fields differ between an existing record and incoming raw record. */
function hasFieldChanges(existing: DealRegistration, incoming: RawDrRecord): boolean {
  const fields: Array<keyof RawDrRecord> = [
    'opportunityName', 'accountName', 'repName', 'secondOwner', 'channelAccountManager',
    'resellerName', 'distributorReseller', 'product', 'stage', 'probability', 'amount',
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
  const oppMap = new Map(opportunities.map(o => [o.id, o]));

  let newCount = 0;
  let updatedCount = 0;
  let rejectedCount = 0;
  let convertedCount = 0;

  const merged: DealRegistration[] = [];

  // Step 1: process incoming records (new + updates)
  for (const inc of incoming) {
    const prev = existingMap.get(inc.opportunityId);
    const isSql = inc.probability >= PRE_SQL_PROB;

    if (!prev) {
      newCount++;
      const initialHistory: DrStageHistoryEntry = {
        stage: inc.stage,
        probability: inc.probability,
        date: importedAt,
        batchId,
      };
      const rec: DealRegistration = {
        ...inc,
        batchIdFirstSeen: batchId,
        firstSeenAt: importedAt,
        lastSeenAt: importedAt,
        lastUpdatedAt: importedAt,
        stageHistory: [initialHistory],
        isSql,
        sqlDate: isSql ? importedAt : undefined,
        status: 'active',
      };
      merged.push(rec);
    } else {
      const changed = hasFieldChanges(prev, inc);
      if (changed) updatedCount++;

      const stageChanged = prev.stage !== inc.stage || prev.probability !== inc.probability;
      const stageHistory = stageChanged
        ? [...prev.stageHistory, { stage: inc.stage, probability: inc.probability, date: importedAt, batchId }]
        : prev.stageHistory;

      const wasSql = prev.isSql;
      const sqlDate = wasSql ? prev.sqlDate : (isSql ? importedAt : undefined);

      const rec: DealRegistration = {
        ...prev,
        // mutable updates
        opportunityName: inc.opportunityName,
        accountName: inc.accountName,
        repName: inc.repName,
        secondOwner: inc.secondOwner,
        channelAccountManager: inc.channelAccountManager,
        resellerName: inc.resellerName,
        distributorReseller: inc.distributorReseller,
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
        // lifecycle
        lastSeenAt: importedAt,
        lastUpdatedAt: changed ? importedAt : prev.lastUpdatedAt,
        stageHistory,
        isSql,
        sqlDate,
        // status recomputed below in Step 3
        status: prev.status,
        convertedAt: prev.convertedAt,
        rejectedAt: prev.rejectedAt,
      };
      merged.push(rec);
    }
  }

  // Step 2: existing records NOT in incoming → rejected or converted
  for (const prev of existing) {
    if (incomingMap.has(prev.opportunityId)) continue;
    const opp = oppMap.get(prev.opportunityId);
    const pipelineClass = classifyByPipeline(opp);

    if (pipelineClass) {
      const isFirstConversion = !prev.convertedAt;
      if (isFirstConversion) convertedCount++;
      merged.push({
        ...prev,
        status: pipelineClass.status,
        convertedAt: prev.convertedAt || importedAt,
      });
    } else {
      const isNewlyRejected = prev.status !== 'rejected';
      if (isNewlyRejected) rejectedCount++;
      merged.push({
        ...prev,
        status: 'rejected',
        rejectedAt: prev.rejectedAt || importedAt,
      });
    }
  }

  // Step 3: recompute status for records still present in incoming
  // Need account/CAM grouping for padded detection
  const presentRecs = merged.filter(r => incomingMap.has(r.opportunityId));
  const byAcctCam = new Map<string, DealRegistration[]>();
  for (const r of presentRecs) {
    const k = `${(r.accountName || '(none)').toLowerCase()}||${(r.channelAccountManager || '(none)').toLowerCase()}`;
    const arr = byAcctCam.get(k) || [];
    arr.push(r);
    byAcctCam.set(k, arr);
  }

  for (let i = 0; i < merged.length; i++) {
    const r = merged[i];
    if (!incomingMap.has(r.opportunityId)) continue;

    // 1) Pipeline match wins
    const opp = oppMap.get(r.opportunityId);
    const pipelineClass = classifyByPipeline(opp);
    if (pipelineClass) {
      const isFirstConversion = !r.convertedAt;
      if (isFirstConversion) convertedCount++;
      merged[i] = {
        ...r,
        status: pipelineClass.status,
        convertedAt: r.convertedAt || importedAt,
      };
      continue;
    }

    // 2) SQL
    if (r.isSql) {
      merged[i] = { ...r, status: 'sql' };
      continue;
    }

    // 3) Padded: pre-SQL, on account+CAM with 2+ pre-SQL DRs, no lastActivity
    const k = `${(r.accountName || '(none)').toLowerCase()}||${(r.channelAccountManager || '(none)').toLowerCase()}`;
    const group = byAcctCam.get(k) || [];
    const preSqlInGroup = group.filter(x => !x.isSql);
    if (preSqlInGroup.length >= 2 && !r.lastActivity) {
      merged[i] = { ...r, status: 'padded' };
      continue;
    }

    // 4) Stale
    if (isStaleFor(r)) {
      merged[i] = { ...r, status: 'stale' };
      continue;
    }

    // 5) Active
    merged[i] = { ...r, status: 'active' };
  }

  return { merged, stats: { newCount, updatedCount, rejectedCount, convertedCount } };
}
