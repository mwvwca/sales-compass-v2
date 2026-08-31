import { describe, it, expect } from 'vitest';
import {
  buildTeamRepNameSet,
  isTeamOwned,
  isTeamStatus,
  ownerNamesIn,
  rosterKey,
  unknownOwnerNames,
  normalizeRepName,
} from '@/lib/repUtils';
import { compactSnapshots } from '@/lib/storageCompaction';
import type { OpportunitySnapshot } from '@/types/forecast';

describe('rosterKey', () => {
  it('trims and otherwise preserves the Salesforce spelling exactly', () => {
    expect(rosterKey('  Mark Belanger  ')).toBe('Mark Belanger');
    expect(rosterKey('Rich  Morris')).toBe('Rich  Morris'); // inner spacing preserved
    expect(rosterKey(null)).toBe('');
    expect(rosterKey(undefined)).toBe('');
  });
});

describe('membership toggling', () => {
  const roster = [
    { id: '1', name: 'Mark Belanger', status: 'team' as const },
    { id: '2', name: 'Brian Walsh', status: 'team' as const },
    { id: '3', name: 'Dan Culleton', status: 'not_team' as const },
  ];

  it('a toggled-off member drops out of the team set immediately', () => {
    const before = buildTeamRepNameSet(roster);
    expect(isTeamOwned({ repName: 'Brian Walsh' }, before)).toBe(true);

    // The toggle the roster panel performs — nothing else changes, no reimport.
    const after = buildTeamRepNameSet(
      roster.map(r => (r.id === '2' ? { ...r, status: 'not_team' as const } : r)),
    );
    expect(isTeamOwned({ repName: 'Brian Walsh' }, after)).toBe(false);
    expect(isTeamOwned({ repName: 'Mark Belanger' }, after)).toBe(true);
  });

  it('a toggled-on owner joins the team set immediately', () => {
    const after = buildTeamRepNameSet(
      roster.map(r => (r.id === '3' ? { ...r, status: 'team' as const } : r)),
    );
    expect(isTeamOwned({ repName: 'Dan Culleton' }, after)).toBe(true);
  });

  it('Walsh behaves exactly as before while left on the team', () => {
    const set = buildTeamRepNameSet(roster);
    expect(isTeamOwned({ repName: 'Brian Walsh' }, set)).toBe(true);
  });
});

describe('isTeamStatus', () => {
  it('defaults a missing status to team (pre-roster entries were the team list)', () => {
    expect(isTeamStatus({})).toBe(true);
    expect(isTeamStatus({ status: 'team' })).toBe(true);
    expect(isTeamStatus({ status: 'not_team' })).toBe(false);
  });
});

describe('ownerNamesIn', () => {
  it('collects distinct trimmed owner names', () => {
    const names = ownerNamesIn([
      { repName: 'Mark Belanger' },
      { repName: '  Mark Belanger  ' },
      { repName: 'Dan Culleton' },
      { repName: '' },
      { repName: null },
    ]);
    expect([...names].sort()).toEqual(['Dan Culleton', 'Mark Belanger']);
  });

  it('keeps a case variant separate from the canonical spelling', () => {
    const names = ownerNamesIn([{ repName: 'Rich Morris' }, { repName: 'Richard Morris' }]);
    expect(names.size).toBe(2);
  });
});

describe('import auto-add of unknown owners', () => {
  // Mirrors what importOpportunities does: every unknown owner in the batch becomes a
  // not_team roster entry, and membership for that same import is judged against the
  // roster INCLUDING the additions — so a brand-new owner reads as off-team at once.
  function applyImport(
    reps: { id: string; name: string; status: 'team' | 'not_team'; firstSeen?: string }[],
    incoming: { repName: string }[],
    today = '2026-08-31',
  ) {
    const newOwners = unknownOwnerNames(reps, ownerNamesIn(incoming));
    const additions = newOwners.map((name, i) => ({
      id: `new-${i}`, name, status: 'not_team' as const, firstSeen: today,
    }));
    const next = [...reps, ...additions];
    return { newOwners, reps: next, teamSet: buildTeamRepNameSet(next) };
  }

  const seeded = [
    { id: '1', name: 'Mark Belanger', status: 'team' as const },
    { id: '2', name: 'Brian Walsh', status: 'team' as const },
  ];

  it('classifies a never-seen owner off-team and reports it for the notice', () => {
    const r = applyImport(seeded, [
      { repName: 'Mark Belanger' },
      { repName: 'Dan Culleton' },
    ]);
    expect(r.newOwners).toEqual(['Dan Culleton']);
    expect(isTeamOwned({ repName: 'Dan Culleton' }, r.teamSet)).toBe(false);
    expect(isTeamOwned({ repName: 'Mark Belanger' }, r.teamSet)).toBe(true);
    expect(r.reps.find(x => x.name === 'Dan Culleton')?.status).toBe('not_team');
  });

  it('adds nothing and raises no notice when every owner is already known', () => {
    const r = applyImport(seeded, [{ repName: 'Mark Belanger' }, { repName: 'Brian Walsh' }]);
    expect(r.newOwners).toEqual([]);
    expect(r.reps).toHaveLength(2);
  });

  it('surfaces a Salesforce name variant as a new owner rather than silently matching', () => {
    // The Richard/Rich Morris, Matt/Matthew Johnson drift pattern. The variant must not
    // fold into the existing entry — it defaults off-team and shows up for review.
    const r = applyImport([{ id: '1', name: 'Rich Morris', status: 'team' }], [{ repName: 'Richard Morris' }]);
    expect(r.newOwners).toEqual(['Richard Morris']);
    expect(isTeamOwned({ repName: 'Richard Morris' }, r.teamSet)).toBe(false);
    // ...and the loose comparison still shows they are the same person, which is what
    // the roster-seed heal and the goal editor's duplicate guard rely on.
    expect(normalizeRepName('Rich Morris')).not.toBe(normalizeRepName('Richard Morris'));
    expect(normalizeRepName('RICHARD MORRIS')).toBe(normalizeRepName('Richard Morris'));
  });

  it('records first-seen on the auto-added entry', () => {
    const r = applyImport(seeded, [{ repName: 'Dan Culleton' }], '2026-08-31');
    expect(r.reps.find(x => x.name === 'Dan Culleton')?.firstSeen).toBe('2026-08-31');
  });
});

describe('no compaction interaction', () => {
  // Roster state lives entirely outside the snapshot; owner (repName) was already part
  // of snapshotSignature and stays there. Nothing about this change alters de-dup.
  function snap(over: Partial<OpportunitySnapshot> & { importDate: string }): OpportunitySnapshot {
    return {
      opportunityId: 'A', fileName: 'f.xlsx', amount: 1000, closeDate: '2026-09-30',
      stage: 'Commercial', classification: 'commit', name: 'Opp', repName: 'Mark Belanger', ...over,
    };
  }

  it('collapses unchanged snapshots exactly as before', () => {
    expect(compactSnapshots([
      snap({ importDate: '2026-08-01' }),
      snap({ importDate: '2026-08-15' }),
      snap({ importDate: '2026-08-31' }),
    ])).toHaveLength(1);
  });

  it('still keeps a snapshot when the owner changes', () => {
    expect(compactSnapshots([
      snap({ importDate: '2026-08-01', repName: 'Mark Belanger' }),
      snap({ importDate: '2026-08-31', repName: 'Dan Culleton' }),
    ])).toHaveLength(2);
  });
});
