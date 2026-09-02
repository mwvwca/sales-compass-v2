import { describe, it, expect } from 'vitest';
import type { ChangeLogEntry, Opportunity, OpportunitySnapshot, Rep } from '@/types/forecast';
import {
  buildFridayBriefing, buildRepPipeline, cleanBriefingMeta, cohortTotal, computeMovement,
  EMPTY_BRIEFING_META, movementBaseline, recordRun, repNotesForPeriod, selectBigDeals,
  toCohortMember, type BriefingRun,
} from '@/lib/bigDeals';
import { applyInvolvement, cleanInvolvement, involvementFor, nextInvolvementStatus, type InvolvementMap } from '@/lib/involvement';

const NOW = new Date('2026-09-04T17:00:00Z'); // a Friday
const PERIOD = '2026-08-31'; // Monday of that ISO week

const rep = (name: string, over: Partial<Rep> = {}): Rep => ({
  id: name, name, status: 'team', firstSeen: '2026-01-01', quarterlyGoals: {}, isActive: true, ...over,
});

const opp = (over: Partial<Opportunity> & { id: string }): Opportunity => ({
  name: 'Deal', repId: '', repName: 'Winters', amount: 50_000, closeDate: '2026-09-15',
  stage: 'Technical', classification: 'commit', probability: 0.5, importDate: '2026-08-01T00:00:00Z',
  salesforceId: over.id, ...over,
});

const REPS = [rep('Winters'), rep('Pearson'), rep('Belanger'), rep('Off Team', { status: 'not_team' })];
const NO_SNAPS: OpportunitySnapshot[] = [];
const NO_INV: InvolvementMap = {};

const cohort = (opps: Opportunity[], threshold = 30_000, involvement: InvolvementMap = NO_INV) =>
  selectBigDeals({ opportunities: opps, reps: REPS, snapshots: NO_SNAPS, involvement, monthKey: '2026-09', threshold, now: NOW });

describe('selectBigDeals', () => {
  const opps = [
    opp({ id: '006A', name: 'Big One', amount: 158_845, closeDate: '2026-09-30' }),
    opp({ id: '006B', name: 'At Threshold', amount: 30_000 }),
    opp({ id: '006C', name: 'Below Threshold', amount: 29_999 }),
    opp({ id: '006D', name: 'Next Month', closeDate: '2026-10-01' }),
    opp({ id: '006E', name: 'Closed Won', stage: 'Closed Won', classification: 'closed_won', amount: 90_000 }),
    opp({ id: '006F', name: 'Closed Lost', stage: 'Closed Lost', classification: 'lost', amount: 90_000 }),
    opp({ id: '006G', name: 'Off Team', repName: 'Off Team', amount: 90_000 }),
  ];

  it('keeps only team-owned, open, in-month deals at or above the threshold', () => {
    expect(cohort(opps).map(r => r.opp.name)).toEqual(['Big One', 'At Threshold']);
  });

  it('sorts by amount descending and totals the cohort', () => {
    expect(cohortTotal(cohort(opps))).toBe(188_845);
  });

  it('follows a roster toggle at render time with no reimport', () => {
    const promoted = [rep('Winters'), rep('Off Team', { status: 'team' })];
    const rows = selectBigDeals({
      opportunities: opps, reps: promoted, snapshots: NO_SNAPS, involvement: NO_INV,
      monthKey: '2026-09', threshold: 30_000, now: NOW,
    });
    expect(rows.map(r => r.opp.name)).toContain('Off Team');
  });

  it('flags an unquoted amount and an Amount/Monthly mismatch', () => {
    const rows = cohort([
      opp({ id: '006H', name: 'No Quote', amount: 99_092, amountMonthly: null }),
      opp({ id: '006I', name: 'Mismatch', amount: 120_000, amountMonthly: 1_000 }),
      opp({ id: '006J', name: 'Clean', amount: 60_000, amountMonthly: 5_000 }),
    ]);
    expect(rows.find(r => r.opp.name === 'No Quote')!.quoteState).toBe('unquoted');
    expect(rows.find(r => r.opp.name === 'Mismatch')!.quoteState).toBe('quoted-mismatch');
    expect(rows.find(r => r.opp.name === 'Clean')!.quoteState).toBe('quoted-clean');
  });
});

describe('involvement', () => {
  it('cycles not_yet → scheduled → introduced → not_yet', () => {
    expect(nextInvolvementStatus('not_yet')).toBe('scheduled');
    expect(nextInvolvementStatus('scheduled')).toBe('introduced');
    expect(nextInvolvementStatus('introduced')).toBe('not_yet');
  });

  it('stamps the date on a dated status and clears it on not_yet', () => {
    const a = applyInvolvement({}, '006A', { status: 'introduced' }, NOW);
    expect(a['006A'].date).toBe('2026-09-04');
    const b = applyInvolvement(a, '006A', { status: 'not_yet' }, NOW);
    expect(b['006A'].date).toBe('');
  });

  it('keeps an explicit date and an edited note', () => {
    const m = applyInvolvement({}, '006A', { status: 'scheduled', date: '2026-09-10', note: 'exec sponsor intro' }, NOW);
    expect(m['006A']).toMatchObject({ status: 'scheduled', date: '2026-09-10', note: 'exec sponsor intro' });
  });

  it('is keyed on the Salesforce id, so an import that replaces the record cannot touch it', () => {
    const involvement = applyInvolvement({}, '006A', { status: 'introduced', note: 'ran the exec call' }, NOW);
    // The import merge rebuilds the opportunity from the export: new internal id, new
    // amount/stage/close date. Only the Salesforce id survives — and that is the join key.
    const reimported = opp({ id: '006A', amount: 175_000, stage: 'Commercial', closeDate: '2026-09-28' });
    const rows = cohort([reimported], 30_000, involvement);
    expect(rows[0].involvement.status).toBe('introduced');
    expect(rows[0].involvement.note).toBe('ran the exec call');
  });

  it('drops malformed persisted entries instead of surfacing them', () => {
    const cleaned = cleanInvolvement({ '006A': { status: 'bogus' }, '006B': null, '006C': { status: 'scheduled', date: '2026-09-01', note: 'x', updatedAt: 'y' } });
    expect(cleaned['006A'].status).toBe('not_yet');
    expect(cleaned['006B']).toBeUndefined();
    expect(cleaned['006C'].status).toBe('scheduled');
    expect(cleanInvolvement(null)).toEqual({});
  });

  it('returns the neutral default for an untracked deal', () => {
    expect(involvementFor({}, '006Z').status).toBe('not_yet');
  });
});

describe('briefing meta', () => {
  it('treats a missing or malformed value as the empty meta', () => {
    expect(cleanBriefingMeta(null)).toEqual(EMPTY_BRIEFING_META);
    expect(cleanBriefingMeta({ monthlyTarget: 'nope' }).monthlyTarget).toBe(1_200_000);
  });

  it('measures a new period against the run on record, and keeps that window on a regenerate', () => {
    const first: BriefingRun = { generatedAt: '2026-08-28T17:00:00Z', monthKey: '2026-09', threshold: 30_000, cohort: [] };
    const afterFirst = recordRun(EMPTY_BRIEFING_META, '2026-08-24', first);
    // New week: measured against last week's run.
    expect(movementBaseline(afterFirst, PERIOD).generatedAt).toBe(first.generatedAt);
    const second: BriefingRun = { generatedAt: '2026-09-04T17:00:00Z', monthKey: '2026-09', threshold: 30_000, cohort: [] };
    const afterSecond = recordRun(afterFirst, PERIOD, second);
    // Regenerating the same Friday still reports the whole week, not the last five minutes.
    expect(movementBaseline(afterSecond, PERIOD).generatedAt).toBe(first.generatedAt);
    const third = recordRun(afterSecond, PERIOD, { ...second, generatedAt: '2026-09-04T18:00:00Z' });
    expect(movementBaseline(third, PERIOD).generatedAt).toBe(first.generatedAt);
  });

  it('starts rep commentary fresh each period', () => {
    const meta = { ...EMPTY_BRIEFING_META, notesPeriod: '2026-08-24', repNotes: { Winters: 'last week' } };
    expect(repNotesForPeriod(meta, '2026-08-24')).toEqual({ Winters: 'last week' });
    expect(repNotesForPeriod(meta, PERIOD)).toEqual({});
    expect(recordRun(meta, PERIOD, { generatedAt: 'x', monthKey: '2026-09', threshold: 30_000, cohort: [] }).repNotes).toEqual({});
  });
});

describe('computeMovement', () => {
  const WINDOW = '2026-08-28T17:00:00Z';
  const stayed = opp({ id: '006A', name: 'Stayed', amount: 158_845, stage: 'Commercial' });
  const won = opp({ id: '006W', name: 'Won Deal', amount: 80_000, stage: 'Closed Won', classification: 'closed_won' });
  const lost = opp({ id: '006L', name: 'Lost Deal', amount: 40_000, stage: 'Closed Lost', classification: 'lost', lostReason: 'No budget' });
  const pushed = opp({ id: '006P', name: 'Pushed Deal', amount: 60_000, closeDate: '2026-10-15' });
  const shrunk = opp({ id: '006S', name: 'Shrunk Deal', amount: 12_000 });
  const opps = [stayed, won, lost, pushed, shrunk];

  const base: BriefingRun = {
    generatedAt: WINDOW,
    monthKey: '2026-09',
    threshold: 30_000,
    cohort: [stayed, won, lost, pushed, shrunk].map(o => ({
      key: o.id, name: o.name, rep: o.repName, amount: o.id === '006S' ? 55_000 : o.amount,
      stage: 'Technical', closeDate: '2026-09-15',
    })),
  };

  const changelog: ChangeLogEntry[] = [
    { id: '1', importDate: '2026-09-01T00:00:00Z', fileName: 'f', opportunityId: '006A', opportunityName: 'Stayed', repName: 'Winters', field: 'stage', oldValue: 'Technical', newValue: 'Discovery' },
    { id: '2', importDate: '2026-09-03T00:00:00Z', fileName: 'f', opportunityId: '006A', opportunityName: 'Stayed', repName: 'Winters', field: 'stage', oldValue: 'Discovery', newValue: 'Commercial' },
    { id: '3', importDate: '2026-08-20T00:00:00Z', fileName: 'f', opportunityId: '006A', opportunityName: 'Stayed', repName: 'Winters', field: 'amount', oldValue: '100000', newValue: '158845' },
    { id: '4', importDate: '2026-09-02T00:00:00Z', fileName: 'f', opportunityId: '006A', opportunityName: 'Stayed', repName: 'Winters', field: 'closeDate', oldValue: '2026-09-15', newValue: '2026-09-15' },
  ];

  const move = (baseline: BriefingRun, monthKey = '2026-09', threshold = 30_000) =>
    computeMovement({ rows: cohort(opps, threshold), opportunities: opps, reps: REPS, changelog, baseline, monthKey, threshold });

  it('reports a baseline week when nothing was ever generated', () => {
    const m = move({ generatedAt: '', monthKey: '', threshold: 30_000, cohort: [] });
    expect(m.baseline).toBe(true);
    expect(m.departures).toEqual([]);
  });

  it('collapses repeated stage moves into one first→last pair and ignores pre-window rows', () => {
    const m = move(base);
    const stages = m.changes.filter(c => c.kind === 'stage');
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({ from: 'Technical', to: 'Commercial' });
    // The amount row predates the window; the close-date row did not actually change.
    expect(m.changes.map(c => c.kind)).toEqual(['stage']);
  });

  it('explains every departure and leads with closed won', () => {
    const m = move(base);
    expect(m.departures.map(d => [d.member.name, d.kind])).toEqual([
      ['Won Deal', 'won'],
      ['Lost Deal', 'lost'],
      ['Pushed Deal', 'pushed'],
      ['Shrunk Deal', 'below_threshold'],
    ]);
    expect(m.departures[1].detail).toContain('No budget');
    expect(m.departures[2].detail).toContain('pushed out of the month');
    expect(m.departures[3].detail).toContain('dropped below');
  });

  it('falls back to a baseline when the previous briefing used a different selection', () => {
    expect(move({ ...base, threshold: 50_000 }).selectionChanged).toBe(true);
    expect(move({ ...base, monthKey: '2026-08' }).selectionChanged).toBe(true);
  });
});

describe('buildRepPipeline', () => {
  const opps = [
    opp({ id: '006A', repName: 'Winters', amount: 200_000, closeDate: '2026-09-15' }),
    opp({ id: '006B', repName: 'Winters', amount: 100_000, closeDate: '2026-07-15' }), // past-dated, still open
    opp({ id: '006C', repName: 'Winters', amount: 500_000, closeDate: '2026-11-01' }), // next quarter
    opp({ id: '006D', repName: 'Pearson', amount: 50_000 }),
    opp({ id: '006E', repName: 'Pearson', amount: 150_000, stage: 'Closed Won', classification: 'closed_won' }),
    opp({ id: '006F', repName: 'Off Team', amount: 900_000 }),
  ];
  const reps = [
    rep('Winters', { quarterlyGoals: { '2026-Q3': 400_000 } }),
    rep('Pearson', { quarterlyGoals: { '2026-Q3': 400_000 } }),
    rep('Belanger', { isActive: false }),
    rep('Off Team', { status: 'not_team' }),
  ];

  const rows = buildRepPipeline({ opportunities: opps, reps, quarter: '2026-Q3', coverageLine: 3, repNotes: { Winters: 'two new POVs' } });

  it('counts in-quarter open pipeline per team rep and drops off-team and inactive reps', () => {
    expect(rows.map(r => r.repName)).toEqual(['Pearson', 'Winters']);
    expect(rows.find(r => r.repName === 'Winters')).toMatchObject({ openAmount: 300_000, openCount: 2, note: 'two new POVs' });
  });

  it('measures coverage against the goal not yet won and flags a thin quarter', () => {
    const pearson = rows.find(r => r.repName === 'Pearson')!;
    expect(pearson.wonInQuarter).toBe(150_000);
    expect(pearson.remainingGoal).toBe(250_000);
    expect(pearson.coverage).toBeCloseTo(0.2);
    expect(pearson.thin).toBe(true);
  });

  it('does not flag a rep with no goal to measure against', () => {
    const noGoal = buildRepPipeline({ opportunities: opps, reps: [rep('Winters')], quarter: '2026-Q3', coverageLine: 3, repNotes: {} });
    expect(noGoal[0].coverage).toBeNull();
    expect(noGoal[0].thin).toBe(false);
  });
});

describe('buildFridayBriefing', () => {
  const opps = [
    opp({ id: '006A', name: 'Ann Arbor Public Schools', repName: 'Winters', amount: 158_845, closeDate: '2026-09-30', stage: 'Qualified', amountMonthly: 13_237.08 }),
    opp({ id: '006B', name: 'City of Englewood', repName: 'Seihoun', amount: 99_092, amountMonthly: null }),
    opp({ id: '006C', name: 'Bridgeport Schools', repName: 'Belanger', amount: 120_000, amountMonthly: 1_000 }),
  ];
  const reps = [rep('Winters'), rep('Seihoun'), rep('Belanger', { quarterlyGoals: { '2026-Q3': 500_000 } })];
  const involvement = applyInvolvement({}, '006A', { status: 'introduced', date: '2026-09-02', note: 'ran the exec call' }, NOW);
  const rows = selectBigDeals({ opportunities: opps, reps, snapshots: NO_SNAPS, involvement, monthKey: '2026-09', threshold: 30_000, now: NOW });
  const repRows = buildRepPipeline({ opportunities: opps, reps, quarter: '2026-Q3', coverageLine: 3, repNotes: { Belanger: 'three CAM meetings booked' } });

  const text = buildFridayBriefing({
    rows,
    movement: { baseline: true, selectionChanged: false, windowStart: '', departures: [], changes: [] },
    repRows, monthKey: '2026-09', quarter: '2026-Q3', threshold: 30_000,
    monthlyTarget: 1_200_000, coverageLine: 3, now: NOW,
  });

  it('phrases the header as progress toward the path', () => {
    expect(text).toContain('3 deals, $378K of the $1.2M September path');
  });

  it('lists every cohort deal with its involvement status and role note', () => {
    for (const name of ['Ann Arbor Public Schools', 'City of Englewood', 'Bridgeport Schools']) {
      expect(text).toContain(name);
    }
    expect(text).toContain('introduced Sep 2');
    expect(text).toContain('ran the exec call');
  });

  it('footnotes only the flags actually present, with their explanation', () => {
    expect(text).toContain('[1] mismatch = Amount disagrees with quoted monthly');
    expect(text).toContain('[2] unquoted = registration estimate, no quote produced yet.');
  });

  it('says baseline week on the first run instead of inventing deltas', () => {
    expect(text).toContain('Baseline week');
  });

  it('carries the rep commentary and flags the thin rep', () => {
    expect(text).toContain('three CAM meetings booked');
    expect(text).toContain('below coverage line');
  });

  it('reports closed won first in the movement section once there is a window', () => {
    const withMovement = buildFridayBriefing({
      rows,
      movement: {
        baseline: false, selectionChanged: false, windowStart: '2026-08-28T17:00:00Z',
        departures: [
          { kind: 'lost', member: { key: '006L', name: 'Lost Deal', rep: 'Winters', amount: 40_000, stage: 'Technical', closeDate: '2026-09-15' }, detail: 'closed lost', amount: 40_000 },
          { kind: 'won', member: { key: '006W', name: 'Won Deal', rep: 'Pearson', amount: 80_000, stage: 'Technical', closeDate: '2026-09-15' }, detail: 'CLOSED WON $80,000', amount: 80_000 },
        ],
        changes: [{ key: '006A', name: 'Ann Arbor Public Schools', rep: 'Winters', amount: 158_845, kind: 'stage', from: 'Qualified', to: 'Discovery' }],
      },
      repRows, monthKey: '2026-09', quarter: '2026-Q3', threshold: 30_000,
      monthlyTarget: 1_200_000, coverageLine: 3, now: NOW,
    });
    const wonAt = withMovement.indexOf('Won Deal');
    const lostAt = withMovement.indexOf('Lost Deal');
    expect(wonAt).toBeGreaterThan(-1);
    expect(wonAt).toBeLessThan(lostAt);
    expect(withMovement).toContain('Closed won out of the cohort this week: $80,000 across 1.');
    expect(withMovement).toContain('stage Qualified → Discovery');
  });
});

describe('toCohortMember', () => {
  it('captures what the next briefing needs to explain a departure', () => {
    const [row] = cohort([opp({ id: '006A', name: 'Big One', amount: 158_845 })]);
    expect(toCohortMember(row)).toEqual({
      key: '006A', name: 'Big One', rep: 'Winters', amount: 158_845, stage: 'Technical', closeDate: '2026-09-15',
    });
  });
});
