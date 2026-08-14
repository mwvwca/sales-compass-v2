import { describe, it, expect } from 'vitest';
import {
  daysSinceStageChange,
  lastStageChangeISO,
  oldStageStuckFires,
  compareStageStaleSignal,
  stageHistoryFor,
  absentFromLatestImport,
} from '@/lib/stageStaleness';
import type { Opportunity, OpportunitySnapshot } from '@/types/forecast';

const NOW = new Date('2026-03-01T00:00:00Z');

function snap(over: Partial<OpportunitySnapshot> & { opportunityId: string; importDate: string; stage: string }): OpportunitySnapshot {
  return { fileName: 'f', amount: 1000, closeDate: '2026-06-01', classification: 'commit', name: 'Opp', repName: 'Rep', ...over };
}
const opp = (over: Partial<Opportunity> & { id: string }): Opportunity => ({
  name: 'Opp', repId: '', repName: 'Rep', amount: 1000, closeDate: '2026-06-01', stage: 'Discovery',
  classification: 'commit', probability: 0.4, importDate: '2026-01-01T00:00:00Z', ...over,
});

describe('daysSinceStageChange', () => {
  it('measures days since the most recent stage change', () => {
    const history = [
      snap({ opportunityId: 'A', importDate: '2026-01-01T00:00:00Z', stage: 'Discovery' }),
      snap({ opportunityId: 'A', importDate: '2026-02-01T00:00:00Z', stage: 'Technical' }), // changed here
      snap({ opportunityId: 'A', importDate: '2026-02-15T00:00:00Z', stage: 'Technical' }), // no change
    ];
    // from 2026-02-01 to 2026-03-01 = 28 days
    expect(daysSinceStageChange(history, opp({ id: 'A' }), NOW)).toBe(28);
  });

  it('falls back to first-seen (earliest snapshot) when stage never changed', () => {
    const history = [
      snap({ opportunityId: 'A', importDate: '2026-01-10T00:00:00Z', stage: 'Discovery' }),
      snap({ opportunityId: 'A', importDate: '2026-02-10T00:00:00Z', stage: 'Discovery' }),
    ];
    // from earliest snapshot 2026-01-10 to 2026-03-01 = 50 days
    expect(daysSinceStageChange(history, opp({ id: 'A' }), NOW)).toBe(50);
  });

  it('falls back to opportunity importDate when there are no snapshots', () => {
    expect(daysSinceStageChange([], opp({ id: 'A', importDate: '2026-01-01T00:00:00Z' }), NOW)).toBe(59);
  });

  it('ignores case/whitespace when detecting a stage change', () => {
    const history = [
      snap({ opportunityId: 'A', importDate: '2026-01-01T00:00:00Z', stage: 'Discovery' }),
      snap({ opportunityId: 'A', importDate: '2026-02-01T00:00:00Z', stage: '  discovery ' }),
    ];
    // treated as unchanged → falls back to first-seen (2026-01-01 → 59 days), not 28
    expect(daysSinceStageChange(history, opp({ id: 'A' }), NOW)).toBe(59);
    expect(lastStageChangeISO(history, opp({ id: 'A' }))).toBe('2026-01-01T00:00:00Z');
  });
});

describe('old vs new comparison', () => {
  it('new rule fires on a long-stalled deal that the old proxy misses (fewer than 3 snapshots)', () => {
    // One snapshot 50 days ago, never changed → old proxy needs >=3 snapshots, misses it.
    const snapshots = [snap({ opportunityId: 'A', importDate: '2026-01-10T00:00:00Z', stage: 'Discovery' })];
    const opps = [opp({ id: 'A' })];
    expect(oldStageStuckFires(stageHistoryFor(opps[0], snapshots))).toBe(false);
    const c = compareStageStaleSignal(opps, snapshots, 30, NOW);
    expect(c.oldFire).toEqual([]);
    expect(c.newFire).toEqual(['A']);
    expect(c.overlap).toBe(0);
    expect(c.newOnly).toBe(1);
  });

  it('reports overlap when both rules fire', () => {
    // 3 snapshots, same stage, earliest 50 days ago → old fires; new fires (50 >= 30).
    const snapshots = [
      snap({ opportunityId: 'A', importDate: '2026-01-10T00:00:00Z', stage: 'Discovery' }),
      snap({ opportunityId: 'A', importDate: '2026-01-20T00:00:00Z', stage: 'Discovery' }),
      snap({ opportunityId: 'A', importDate: '2026-01-30T00:00:00Z', stage: 'Discovery' }),
    ];
    const c = compareStageStaleSignal([opp({ id: 'A' })], snapshots, 30, NOW);
    expect(c.oldFire).toEqual(['A']);
    expect(c.newFire).toEqual(['A']);
    expect(c.overlap).toBe(1);
    expect(c.oldOnly).toBe(0);
    expect(c.newOnly).toBe(0);
  });

  it('flags absence when the latest snapshot predates the latest import, and relabels a stalled fire', () => {
    const latestImport = '2026-02-20T00:00:00Z';
    // Absent: last snapshot 2026-01-10 (< latest import 2026-02-20); never changed → stalled + absent.
    const absentSnaps = [snap({ opportunityId: 'A', importDate: '2026-01-10T00:00:00Z', stage: 'Discovery' })];
    expect(absentFromLatestImport(stageHistoryFor(opp({ id: 'A' }), absentSnaps), latestImport)).toBe('2026-01-10T00:00:00Z');
    const c = compareStageStaleSignal([opp({ id: 'A' })], absentSnaps, 30, NOW, latestImport);
    expect(c.newFire).toEqual(['A']);
    expect(c.absent).toBe(1);
    expect(c.relabeled).toBe(1); // the stalled fire is actually an absence

    // Present: last snapshot == latest import → not absent, stays a normal stalled fire.
    const presentSnaps = [
      snap({ opportunityId: 'B', importDate: '2026-01-10T00:00:00Z', stage: 'Discovery' }),
      snap({ opportunityId: 'B', importDate: latestImport, stage: 'Discovery' }),
    ];
    expect(absentFromLatestImport(stageHistoryFor(opp({ id: 'B' }), presentSnaps), latestImport)).toBeUndefined();
    const c2 = compareStageStaleSignal([opp({ id: 'B' })], presentSnaps, 30, NOW, latestImport);
    expect(c2.absent).toBe(0);
    expect(c2.relabeled).toBe(0);
  });

  it('reports no absence when there is no latest-import date', () => {
    const snaps = [snap({ opportunityId: 'A', importDate: '2026-01-10T00:00:00Z', stage: 'Discovery' })];
    expect(absentFromLatestImport(stageHistoryFor(opp({ id: 'A' }), snaps), undefined)).toBeUndefined();
    expect(compareStageStaleSignal([opp({ id: 'A' })], snaps, 30, NOW).absent).toBe(0);
  });

  it('new rule does NOT fire on a recently-advanced deal that the old proxy would have flagged by count', () => {
    // 3 snapshots but stage changed 5 days ago → old proxy would NOT fire (stages differ) and
    // new rule does NOT fire (5 < 30). Confirms new rule tracks recency, not count.
    const snapshots = [
      snap({ opportunityId: 'A', importDate: '2026-01-10T00:00:00Z', stage: 'Discovery' }),
      snap({ opportunityId: 'A', importDate: '2026-02-01T00:00:00Z', stage: 'Discovery' }),
      snap({ opportunityId: 'A', importDate: '2026-02-24T00:00:00Z', stage: 'Technical' }), // changed 5 days ago
    ];
    const c = compareStageStaleSignal([opp({ id: 'A' })], snapshots, 30, NOW);
    expect(c.newFire).toEqual([]);
  });
});
