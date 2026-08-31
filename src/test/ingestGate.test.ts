import { describe, it, expect } from 'vitest';
import { applyIngestGate, buildKnownIdSet, gateVerdict } from '@/lib/ingestGate';
import { buildTeamRepNameSet } from '@/lib/repUtils';
import {
  planWideImportPurge, applyWideImportPurge, WIDE_IMPORT_CUTOFF, PURGE_MIN, PURGE_MAX,
} from '@/lib/wideImportPurge';
import type { Opportunity, ChangeLogEntry, OpportunitySnapshot, Rep } from '@/types/forecast';

const TEAM = buildTeamRepNameSet([
  { name: 'Brian Walsh', status: 'team' },
  { name: 'Sami Khudair', status: 'team' },
  { name: 'Dan Culleton', status: 'not_team' },
  { name: 'Andrew Sommers', status: 'not_team' },
]);

function opp(over: Partial<Opportunity> & { id: string }): Opportunity {
  return {
    salesforceId: over.id, name: `Deal ${over.id}`, repId: '', repName: 'Brian Walsh',
    amount: 1000, closeDate: '2026-10-01', stage: 'Discovery', classification: 'unclassified',
    probability: 0.25, importDate: '2026-06-01T10:00:00.000Z', ...over,
  };
}

describe('ingest gate — admission rule', () => {
  const known = buildKnownIdSet([opp({ id: '006Vy00000nstHq' }), opp({ id: '006Vy00001KNOWN1' })]);

  it('admits a row whose owner is on the team', () => {
    expect(gateVerdict({ id: '006Vy00001NEW001', salesforceId: '006Vy00001NEW001', repName: 'Brian Walsh' }, TEAM, known)).toBe('team');
  });

  it('admits an off-team row whose Opportunity ID is already stored', () => {
    // The Avreo case: legitimately tracked, since reassigned off-team. Must survive.
    expect(gateVerdict({ id: '006Vy00000nstHq', salesforceId: '006Vy00000nstHq', repName: 'Dan Culleton' }, TEAM, known)).toBe('known-id');
  });

  it('discards an off-team row with an unseen ID', () => {
    expect(gateVerdict({ id: '006Vy00001FOREIGN', salesforceId: '006Vy00001FOREIGN', repName: 'Andrew Sommers' }, TEAM, known)).toBe('discard');
  });

  it('discards a row whose owner is not on the roster at all', () => {
    expect(gateVerdict({ id: '006Vy00001FOREIGN', salesforceId: '006Vy00001FOREIGN', repName: 'Nobody Known' }, TEAM, known)).toBe('discard');
  });

  it('team membership wins over known-ID, so counters never double-count', () => {
    expect(gateVerdict({ id: '006Vy00001KNOWN1', salesforceId: '006Vy00001KNOWN1', repName: 'Brian Walsh' }, TEAM, known)).toBe('team');
  });
});

describe('ingest gate — batch behaviour', () => {
  const stored = [opp({ id: '006Vy00000nstHq', repName: 'Sami Khudair' })];
  const known = buildKnownIdSet(stored);

  it('separates kept from discarded and counts each reason', () => {
    const rows = [
      opp({ id: '006Vy00001TEAM01', repName: 'Brian Walsh' }),
      opp({ id: '006Vy00001TEAM02', repName: 'Sami Khudair' }),
      opp({ id: '006Vy00000nstHq', repName: 'Dan Culleton' }),   // known ID, off-team
      opp({ id: '006Vy00001FGN001', repName: 'Andrew Sommers' }), // discard
      opp({ id: '006Vy00001FGN002', repName: 'Andrew Sommers' }), // discard
      opp({ id: '006Vy00001FGN003', repName: 'Dan Culleton' }),   // discard
    ];
    const r = applyIngestGate(rows, TEAM, known);
    expect(r.counts).toEqual({ keptTeam: 2, keptKnownId: 1, discarded: 3 });
    expect(r.kept.map(o => o.id)).toEqual(['006Vy00001TEAM01', '006Vy00001TEAM02', '006Vy00000nstHq']);
  });

  it('still reports owners of discarded rows, so roster auto-add and the notice work', () => {
    const r = applyIngestGate(
      [opp({ id: '006Vy00001FGN001', repName: 'Andrew Sommers' }),
       opp({ id: '006Vy00001FGN002', repName: 'Andrew Sommers' }),
       opp({ id: '006Vy00001FGN003', repName: 'Dan Culleton' })],
      TEAM, known,
    );
    expect(r.discardedOwners).toEqual(['Andrew Sommers', 'Dan Culleton']);
    expect(r.discardedByOwner).toEqual({ 'Andrew Sommers': 2, 'Dan Culleton': 1 });
  });

  it('produces nothing downstream for discarded rows', () => {
    const r = applyIngestGate([opp({ id: '006Vy00001FGN001', repName: 'Andrew Sommers' })], TEAM, known);
    expect(r.kept).toHaveLength(0);
  });

  it('a wide file of foreign rows collapses to the team + known rows only', () => {
    const wide = [
      opp({ id: '006Vy00001TEAM01', repName: 'Brian Walsh' }),
      ...Array.from({ length: 500 }, (_, i) => opp({ id: `006Vy0000FGN${String(i).padStart(4, '0')}`, repName: 'Andrew Sommers' })),
    ];
    const r = applyIngestGate(wide, TEAM, known);
    expect(r.counts.discarded).toBe(500);
    expect(r.kept).toHaveLength(1);
  });
});

describe('buildKnownIdSet', () => {
  it('indexes both salesforceId and id, matching the merge lookup', () => {
    const ids = buildKnownIdSet([
      { id: 'uuid-1', salesforceId: '006Vy00000nstHq' },
      { id: '006Vy00001RAWID', salesforceId: undefined },
    ]);
    expect(ids.has('006Vy00000nstHq')).toBe(true);
    expect(ids.has('006Vy00001RAWID')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

const REPS: Rep[] = [
  { id: 'r1', name: 'Brian Walsh', status: 'team', firstSeen: '2026-06-01', quarterlyGoals: {}, isActive: true },
  { id: 'r2', name: 'Dan Culleton', status: 'not_team', firstSeen: '2026-08-31', quarterlyGoals: {}, isActive: true },
  { id: 'r3', name: 'Andrew Sommers', status: 'not_team', firstSeen: '2026-08-31', quarterlyGoals: {}, isActive: true },
];

const WIDE = '2026-08-31T20:17:00.000Z';

function change(oppId: string, importDate: string): ChangeLogEntry {
  return {
    id: `${oppId}-${importDate}`, importDate, fileName: 'f.xlsx', opportunityId: oppId,
    opportunityName: 'X', repName: 'Someone', field: 'amount', oldValue: '1', newValue: '2',
  };
}
function snap(oppId: string, importDate: string): OpportunitySnapshot {
  return {
    opportunityId: oppId, importDate, fileName: 'f.xlsx', amount: 1, closeDate: '2026-10-01',
    stage: 'Discovery', classification: 'unclassified', name: 'X', repName: 'Someone',
  };
}

describe('wide-import purge — what survives', () => {
  it('keeps the Avreo record: off-team now, but predates the wide import and has prior history', () => {
    const avreo = opp({
      id: '006Vy00000nstHq', name: 'Deal Reg - LRT - Avreo - Vandis - Adlumin',
      repName: 'Dan Culleton', stage: 'Closed Lost', classification: 'lost',
      importDate: '2026-06-18T09:00:00.000Z',
    });
    const plan = planWideImportPurge(
      [avreo], [change('006Vy00000nstHq', '2026-07-02T10:00:00.000Z')], [], REPS,
    );
    expect(plan.removeRecordIds.has(avreo.id)).toBe(false);
    expect(plan.counts.opportunitiesRemoved).toBe(0);
  });

  it("keeps Brian Walsh's pre-existing record — team-owned fails condition 1", () => {
    const walsh = opp({ id: '006Vy00001WALSH1', repName: 'Brian Walsh', importDate: WIDE });
    const plan = planWideImportPurge([walsh], [], [], REPS);
    expect(plan.removeRecordIds.has(walsh.id)).toBe(false);
  });

  it('keeps an off-team record that predates the wide import (condition 2)', () => {
    const old = opp({ id: '006Vy00001OLD001', repName: 'Dan Culleton', importDate: '2026-07-01T10:00:00.000Z' });
    expect(planWideImportPurge([old], [], [], REPS).counts.opportunitiesRemoved).toBe(0);
  });

  it('keeps an off-team wide-import record that has earlier changelog history (condition 3)', () => {
    const rec = opp({ id: '006Vy00001HIST01', repName: 'Dan Culleton', importDate: WIDE });
    const plan = planWideImportPurge([rec], [change('006Vy00001HIST01', '2026-07-01T10:00:00.000Z')], [], REPS);
    expect(plan.counts.opportunitiesRemoved).toBe(0);
  });

  it('keeps a record imported earlier on 2026-08-31, before the 20:00Z cutoff', () => {
    const morning = opp({ id: '006Vy00001AM0001', repName: 'Dan Culleton', importDate: '2026-08-31T13:14:00.000Z' });
    expect(planWideImportPurge([morning], [], [], REPS).counts.opportunitiesRemoved).toBe(0);
  });
});

describe('wide-import purge — what goes', () => {
  it('removes an off-team record first seen on the wide import with no prior history', () => {
    const foreign = opp({ id: '006Vy00001FGN001', repName: 'Andrew Sommers', importDate: WIDE });
    const plan = planWideImportPurge(
      [foreign],
      [change('006Vy00001FGN001', WIDE)],   // same-import history does not protect it
      [snap('006Vy00001FGN001', WIDE)],
      REPS,
    );
    expect(plan.counts.opportunitiesRemoved).toBe(1);
    expect(plan.counts.changelogRemoved).toBe(1);
    expect(plan.counts.snapshotsRemoved).toBe(1);
  });

  it('deletes changelog and snapshot rows for purged ids so storage actually shrinks', () => {
    const foreign = opp({ id: '006Vy00001FGN001', repName: 'Andrew Sommers', importDate: WIDE });
    const keep = opp({ id: '006Vy00001TEAM01', repName: 'Brian Walsh', importDate: WIDE });
    const changelog = [change('006Vy00001FGN001', WIDE), change('006Vy00001TEAM01', WIDE)];
    const snaps = [snap('006Vy00001FGN001', WIDE), snap('006Vy00001TEAM01', WIDE)];
    const plan = planWideImportPurge([foreign, keep], changelog, snaps, REPS);
    const out = applyWideImportPurge(plan, [foreign, keep], changelog, snaps);
    expect(out.opportunities.map(o => o.id)).toEqual(['006Vy00001TEAM01']);
    expect(out.changelog.map(e => e.opportunityId)).toEqual(['006Vy00001TEAM01']);
    expect(out.snapshots.map(x => x.opportunityId)).toEqual(['006Vy00001TEAM01']);
  });

  it('reports the removal breakdown by owner', () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => opp({ id: `006Vy0000SOM${i}`, repName: 'Andrew Sommers', importDate: WIDE })),
      ...Array.from({ length: 2 }, (_, i) => opp({ id: `006Vy0000CUL${i}`, repName: 'Dan Culleton', importDate: WIDE })),
    ];
    const plan = planWideImportPurge(rows, [], [], REPS);
    expect(plan.removedByOwner).toEqual({ 'Andrew Sommers': 3, 'Dan Culleton': 2 });
  });
});

describe('wide-import purge — sanity band', () => {
  const foreign = (n: number) => Array.from({ length: n }, (_, i) =>
    opp({ id: `006Vy0000F${String(i).padStart(5, '0')}`, repName: 'Andrew Sommers', importDate: WIDE }));

  it('refuses a removal set below the band', () => {
    expect(planWideImportPurge(foreign(PURGE_MIN - 1), [], [], REPS).withinBand).toBe(false);
  });

  it('refuses a removal set above the band', () => {
    expect(planWideImportPurge(foreign(PURGE_MAX + 1), [], [], REPS).withinBand).toBe(false);
  });

  it('accepts a removal set inside the band', () => {
    const plan = planWideImportPurge(foreign(4758), [], [], REPS);
    expect(plan.withinBand).toBe(true);
    expect(plan.counts.opportunitiesRemoved).toBe(4758);
  });

  it('the cutoff constant is the 20:00Z boundary', () => {
    expect(WIDE_IMPORT_CUTOFF).toBe('2026-08-31T20:00:00.000Z');
  });
});
