import { describe, it, expect } from 'vitest';
import { mergeDrBatch } from '@/lib/drMerge';
import { cleanupOffTeamDrs, cleanupOffTeamOpps } from '@/lib/offTeamCleanup';
import { buildTeamRepNameSet } from '@/lib/repUtils';
import type { RawDrRecord, DealRegistration, DrBatch, Opportunity, Rep } from '@/types/forecast';

const IMPORTED_AT = '2026-06-18T08:00:00.000Z';
const TEAM = buildTeamRepNameSet([{ name: 'Alice Active' }, { name: 'Bob Team' }] as Rep[]);

function rawDr(over: Partial<RawDrRecord> & { opportunityId: string }): RawDrRecord {
  return {
    opportunityName: 'Test Opp',
    accountName: 'Acme',
    repName: 'Alice Active',
    createdDate: '2026-01-01',
    closeDate: '2026-03-01',
    stage: 'Discovery 25%',
    probability: 0.25,
    registeredDeal: true,
    ageDays: 30,
    ...over,
  } as RawDrRecord;
}

describe('mergeDrBatch — off-team ingestion gating', () => {
  it('drops an unseen record owned by someone off the roster (not stored)', () => {
    const incoming = [rawDr({ opportunityId: '006Vy00001AAA001', repName: 'Brian Walsh' })];
    const { merged, stats } = mergeDrBatch([], incoming, [], 'b1', IMPORTED_AT, TEAM);
    expect(merged).toHaveLength(0);
    expect(stats.droppedCount).toBe(1);
    expect(stats.newCount).toBe(0);
  });

  it('stores an unseen record owned by a rep on the roster', () => {
    const incoming = [rawDr({ opportunityId: '006Vy00001AAA002', repName: 'Alice Active' })];
    const { merged, stats } = mergeDrBatch([], incoming, [], 'b1', IMPORTED_AT, TEAM);
    expect(merged).toHaveLength(1);
    expect(stats.newCount).toBe(1);
    expect(stats.droppedCount).toBe(0);
  });

  it('normalizes the owner name when matching the roster (case/space insensitive)', () => {
    const incoming = [rawDr({ opportunityId: '006Vy00001AAA003', repName: '  alice   active ' })];
    const { merged } = mergeDrBatch([], incoming, [], 'b1', IMPORTED_AT, TEAM);
    expect(merged).toHaveLength(1);
  });

  it('with an empty roster, does not gate — ingests normally (safety)', () => {
    const incoming = [rawDr({ opportunityId: '006Vy00001AAA004', repName: 'Brian Walsh' })];
    const { merged, stats } = mergeDrBatch([], incoming, [], 'b1', IMPORTED_AT, new Set());
    expect(merged).toHaveLength(1);
    expect(stats.droppedCount).toBe(0);
  });
});

describe('mergeDrBatch — transferred-out indicator', () => {
  it('keeps a previously-seen record when it moves off-team and stamps prior owner + date', () => {
    // First import: Alice owns it (on team) → stored.
    const first = mergeDrBatch([], [rawDr({ opportunityId: '006Vy00001BBB001', repName: 'Alice Active' })], [], 'b1', IMPORTED_AT, TEAM);
    expect(first.merged).toHaveLength(1);

    // Second import: now owned by Brian (off team). It already exists → kept, updated, flagged.
    const NEXT = '2026-07-01T08:00:00.000Z';
    const second = mergeDrBatch(first.merged, [rawDr({ opportunityId: '006Vy00001BBB001', repName: 'Brian Walsh', stage: 'Technical 50%', probability: 0.5, amount: 999 })], [], 'b2', NEXT, TEAM);
    expect(second.merged).toHaveLength(1);
    const rec = second.merged[0];
    expect(rec.repName).toBe('Brian Walsh');
    expect(rec.transferredOutFrom).toBe('Alice Active');
    expect(rec.transferredOutAt).toBe(NEXT);
    // status stays current — stage/amount updates applied
    expect(rec.stage).toBe('Technical 50%');
    expect(rec.amount).toBe(999);
    expect(second.stats.droppedCount).toBe(0);
  });

  it('clears the indicator if ownership returns to the roster', () => {
    const first = mergeDrBatch([], [rawDr({ opportunityId: '006Vy00001BBB002', repName: 'Alice Active' })], [], 'b1', IMPORTED_AT, TEAM);
    const off = mergeDrBatch(first.merged, [rawDr({ opportunityId: '006Vy00001BBB002', repName: 'Brian Walsh' })], [], 'b2', '2026-07-01T00:00:00Z', TEAM);
    expect(off.merged[0].transferredOutFrom).toBe('Alice Active');
    const back = mergeDrBatch(off.merged, [rawDr({ opportunityId: '006Vy00001BBB002', repName: 'Bob Team' })], [], 'b3', '2026-08-01T00:00:00Z', TEAM);
    expect(back.merged[0].transferredOutFrom).toBeUndefined();
    expect(back.merged[0].transferredOutAt).toBeUndefined();
  });
});

function storedDr(over: Partial<DealRegistration> & { opportunityId: string; batchIdFirstSeen: string; repName: string }): DealRegistration {
  return {
    opportunityName: 'X', accountName: 'Acme', createdDate: '2026-01-01', repName: over.repName,
    stage: 'Discovery 25%', probability: 0.25, registeredDeal: true, ageDays: 10,
    firstSeenAt: '', lastSeenAt: '', lastUpdatedAt: '', stageHistory: [], isSql: true, status: 'sql',
    ...over,
  } as DealRegistration;
}

describe('cleanupOffTeamDrs — one-time 8/10 cleanup', () => {
  const batches: DrBatch[] = [
    { id: 'batch-810', importedAt: '', fileName: '8-10.xlsx', recordCount: 0, newCount: 0, updatedCount: 0, rejectedCount: 0, convertedCount: 0, asOfDate: '2026-08-10' },
    { id: 'batch-old', importedAt: '', fileName: 'old.xlsx', recordCount: 0, newCount: 0, updatedCount: 0, rejectedCount: 0, convertedCount: 0, asOfDate: '2026-05-01' },
  ];
  const reps = [{ name: 'Alice Active' }] as Rep[];

  it('deletes off-team records first seen on the 8/10 batch, retains off-team seen earlier and all team records', () => {
    const drs = [
      storedDr({ opportunityId: '1', batchIdFirstSeen: 'batch-810', repName: 'Brian Walsh' }),   // delete
      storedDr({ opportunityId: '2', batchIdFirstSeen: 'batch-810', repName: 'Alice Active' }),   // keep (team)
      storedDr({ opportunityId: '3', batchIdFirstSeen: 'batch-old', repName: 'Brian Walsh' }),    // retain (off-team, earlier)
      storedDr({ opportunityId: '4', batchIdFirstSeen: 'batch-old', repName: 'Alice Active' }),   // keep (team)
    ];
    const res = cleanupOffTeamDrs(drs, batches, reps);
    expect(res.deleted).toBe(1);
    expect(res.retained).toBe(1);
    expect(res.drs.map(d => d.opportunityId).sort()).toEqual(['2', '3', '4']);
  });
});

function storedOpp(over: Partial<Opportunity> & { id: string; repName: string; importDate: string }): Opportunity {
  return {
    name: 'X', repId: '', amount: 1000, closeDate: '2026-09-01', stage: 'Discovery',
    classification: 'commit', probability: 0.25, ...over,
  } as Opportunity;
}

describe('cleanupOffTeamOpps — one-time 8/10 cleanup', () => {
  const reps = [{ name: 'Alice Active' }] as Rep[];
  it('deletes off-team opps first imported 8/10, retains earlier off-team and all team opps', () => {
    const opps = [
      storedOpp({ id: 'a', repName: 'Brian Walsh', importDate: '2026-08-10T09:00:00Z' }),  // delete
      storedOpp({ id: 'b', repName: 'Alice Active', importDate: '2026-08-10T09:00:00Z' }),  // keep (team)
      storedOpp({ id: 'c', repName: 'Brian Walsh', importDate: '2026-06-01T09:00:00Z' }),   // retain
    ];
    const res = cleanupOffTeamOpps(opps, reps);
    expect(res.deleted).toBe(1);
    expect(res.retained).toBe(1);
    expect(res.opps.map(o => o.id).sort()).toEqual(['b', 'c']);
  });
});
