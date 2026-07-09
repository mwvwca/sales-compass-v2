import { describe, it, expect } from 'vitest';
import { mergeDrBatch, backfillDrTerminalStatuses, reconcileTerminalStatus } from '@/lib/drMerge';
import type { RawDrRecord, Opportunity, DealRegistration } from '@/types/forecast';

const IMPORTED_AT = '2026-06-18T08:00:00.000Z';

function rawDr(over: Partial<RawDrRecord> & { opportunityId: string; stage: string }): RawDrRecord {
  return {
    opportunityName: 'Test Opp',
    accountName: 'Acme',
    repName: 'Rep One',
    createdDate: '2026-01-01',
    closeDate: '2026-03-01',
    probability: 1, // Closed Won carries 100% — would otherwise be grabbed by the SQL branch
    registeredDeal: true,
    ageDays: 30,
    ...over,
  } as RawDrRecord;
}

function opp(over: Partial<Opportunity> & { salesforceId: string; stage: string }): Opportunity {
  return {
    id: over.salesforceId,
    name: 'Test Opp',
    repId: '',
    repName: 'Rep One',
    amount: 1000,
    closeDate: '2026-03-01',
    classification: 'unclassified',
    probability: 1,
    importDate: IMPORTED_AT,
    ...over,
  } as Opportunity;
}

describe('mergeDrBatch — closed_won classification', () => {
  it('honors a DR whose own Stage is "Closed Won" even when no Opportunity matches', () => {
    const incoming = [rawDr({ opportunityId: '006Vy00001cDDU6', stage: 'Closed Won' })];
    const { merged } = mergeDrBatch([], incoming, /* no opps */ [], 'batch-1', IMPORTED_AT);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('closed_won');
    // cycle fields derived from the DR's own dates
    expect(merged[0].closedWonDate).toBe('2026-03-01');
    expect(merged[0].cycleDays).toBe(59);
  });

  it('honors a DR whose own Stage is "Closed Lost" when no Opportunity matches', () => {
    const incoming = [rawDr({ opportunityId: '006Vy00001Zh7Hi', stage: 'Closed Lost', probability: 0 })];
    const { merged } = mergeDrBatch([], incoming, [], 'batch-1', IMPORTED_AT);
    expect(merged[0].status).toBe('closed_lost');
  });

  it('still lets a matching Opportunity classify the DR (opp wins when present)', () => {
    const incoming = [rawDr({ opportunityId: '006Vy00001YoQHl', stage: 'Discovery' })];
    const opps = [opp({ salesforceId: '006Vy00001YoQHl', stage: 'Closed Won' })];
    const { merged } = mergeDrBatch([], incoming, opps, 'batch-1', IMPORTED_AT);
    expect(merged[0].status).toBe('closed_won');
  });

  it('joins across a 15-vs-18-char Salesforce ID mismatch (normalized to 15)', () => {
    // DR carries the 18-char form, opp carries the 15-char form (or vice versa).
    const incoming = [rawDr({ opportunityId: '006Vy00001WnGwjAAF', stage: 'Discovery' })];
    const opps = [opp({ salesforceId: '006Vy00001WnGwj', stage: 'Closed Won' })];
    const { merged } = mergeDrBatch([], incoming, opps, 'batch-1', IMPORTED_AT);
    expect(merged[0].status).toBe('closed_won');
  });
});

const IMPORTED_AT_2 = '2026-06-25T08:00:00.000Z';

describe('mergeDrBatch — accountUrl survives the merge', () => {
  it('(a) a new record with accountUrl keeps it after merge', () => {
    const incoming = [rawDr({ opportunityId: '006Vy00001AURL01', stage: 'Discovery', accountUrl: 'https://sf/acct/A' })];
    const { merged } = mergeDrBatch([], incoming, [], 'batch-1', IMPORTED_AT);
    expect(merged[0].accountUrl).toBe('https://sf/acct/A');
  });

  it('(b) an update whose new batch lacks accountUrl retains the previously stored URL', () => {
    const first = mergeDrBatch(
      [], [rawDr({ opportunityId: '006Vy00001AURL02', stage: 'Discovery', accountUrl: 'https://sf/acct/B' })],
      [], 'batch-1', IMPORTED_AT,
    ).merged;
    // Second batch updates the same DR but carries no accountUrl.
    const second = mergeDrBatch(
      first, [rawDr({ opportunityId: '006Vy00001AURL02', stage: 'Technical Validation', accountUrl: undefined })],
      [], 'batch-2', IMPORTED_AT_2,
    ).merged;
    expect(second[0].accountUrl).toBe('https://sf/acct/B');
  });

  it('(c) an update with a new accountUrl overwrites the old one', () => {
    const first = mergeDrBatch(
      [], [rawDr({ opportunityId: '006Vy00001AURL03', stage: 'Discovery', accountUrl: 'https://sf/acct/old' })],
      [], 'batch-1', IMPORTED_AT,
    ).merged;
    const second = mergeDrBatch(
      first, [rawDr({ opportunityId: '006Vy00001AURL03', stage: 'Technical Validation', accountUrl: 'https://sf/acct/new' })],
      [], 'batch-2', IMPORTED_AT_2,
    ).merged;
    expect(second[0].accountUrl).toBe('https://sf/acct/new');
  });
});

describe('mergeDrBatch — terminal statuses are sticky across imports', () => {
  it('a closed_won DR stays closed_won after a later import that does not contain the record', () => {
    // Batch N: DR whose own stage is Closed Won → closed_won, with cohort/cycle fields.
    const first = mergeDrBatch(
      [], [rawDr({ opportunityId: '006Vy00001STK001', stage: 'Closed Won' })],
      [], 'batch-1', IMPORTED_AT,
    ).merged;
    expect(first[0].status).toBe('closed_won');
    expect(first[0].closedWonDate).toBe('2026-03-01');
    const wonCycle = first[0].cycleDays;

    // Batch N+1: a totally different DR; the won one is absent AND has no pipeline opp.
    const second = mergeDrBatch(
      first, [rawDr({ opportunityId: '006Vy00001OTHER1', stage: 'Discovery' })],
      [], 'batch-2', IMPORTED_AT_2,
    ).merged;

    const rec = second.find(d => d.opportunityId === '006Vy00001STK001');
    expect(rec?.status).toBe('closed_won'); // NOT downgraded to 'withdrawn'
    expect(rec?.closedWonDate).toBe('2026-03-01'); // cohort/cycle analytics preserved
    expect(rec?.cycleDays).toBe(wonCycle);
  });

  it('closed_lost and rejected are likewise not downgraded when a later import lacks them', () => {
    const seedLost = mergeDrBatch([], [rawDr({ opportunityId: '006Vy00001STK002', stage: 'Closed Lost', probability: 0 })], [], 'b1', IMPORTED_AT).merged;
    const seedRej = mergeDrBatch(seedLost, [rawDr({ opportunityId: '006Vy00001STK003', stage: 'Rejected', probability: 0 })], [], 'b1b', IMPORTED_AT).merged;
    expect(seedRej.find(d => d.opportunityId === '006Vy00001STK002')?.status).toBe('closed_lost');
    expect(seedRej.find(d => d.opportunityId === '006Vy00001STK003')?.status).toBe('rejected');

    const next = mergeDrBatch(seedRej, [rawDr({ opportunityId: '006Vy00001OTHER2', stage: 'Discovery' })], [], 'b2', IMPORTED_AT_2).merged;
    expect(next.find(d => d.opportunityId === '006Vy00001STK002')?.status).toBe('closed_lost');
    expect(next.find(d => d.opportunityId === '006Vy00001STK003')?.status).toBe('rejected');
  });

  it('a present-in-batch terminal DR is not demoted when its stage goes non-terminal and no opp matches', () => {
    const first = mergeDrBatch([], [rawDr({ opportunityId: '006Vy00001STK004', stage: 'Closed Won' })], [], 'b1', IMPORTED_AT).merged;
    expect(first[0].status).toBe('closed_won');
    // DR reappears with an open-looking stage and no matching pipeline opp.
    const second = mergeDrBatch(first, [rawDr({ opportunityId: '006Vy00001STK004', stage: 'Discovery' })], [], 'b2', IMPORTED_AT_2).merged;
    expect(second[0].status).toBe('closed_won');
  });
});

describe('backfillDrTerminalStatuses — repair pre-stickiness downgrades', () => {
  // Build a real closed_won DR (own terminal stage), then simulate the old bug
  // by forcing it to 'withdrawn' while its win evidence survives.
  const wonViaStage = mergeDrBatch([], [rawDr({ opportunityId: '006Vy00001BKF001', stage: 'Closed Won' })], [], 'b1', IMPORTED_AT).merged[0];
  // A win via Opportunity match: DR's own stage stays non-terminal, but closedWonDate is stamped.
  const wonViaOpp = mergeDrBatch(
    [], [rawDr({ opportunityId: '006Vy00001BKF002', stage: 'Discovery' })],
    [opp({ salesforceId: '006Vy00001BKF002', stage: 'Closed Won' })], 'b1', IMPORTED_AT,
  ).merged[0];
  const lostViaStage = mergeDrBatch([], [rawDr({ opportunityId: '006Vy00001BKF003', stage: 'Closed Lost', probability: 0 })], [], 'b1', IMPORTED_AT).merged[0];
  const rejectedViaStage = mergeDrBatch([], [rawDr({ opportunityId: '006Vy00001BKF004', stage: 'Rejected', probability: 0 })], [], 'b1', IMPORTED_AT).merged[0];

  const corrupt = (dr: DealRegistration, status: DealRegistration['status']): DealRegistration => ({ ...dr, status });

  it('restores closed_won from a surviving closedWonDate even when the stored stage is non-terminal', () => {
    expect(wonViaOpp.status).toBe('closed_won');
    expect(wonViaOpp.closedWonDate).toBeTruthy();
    const broken = corrupt(wonViaOpp, 'withdrawn'); // stage is 'Discovery'
    const fixed = reconcileTerminalStatus(broken);
    expect(fixed.status).toBe('closed_won');
    expect(fixed.closedWonDate).toBe(wonViaOpp.closedWonDate);
    expect(fixed.cycleDays).toBe(wonViaOpp.cycleDays);
  });

  it('restores closed_won / closed_lost / rejected from the DR own terminal stage', () => {
    const input = [
      corrupt(wonViaStage, 'withdrawn'),
      corrupt(lostViaStage, 'withdrawn'),
      corrupt(rejectedViaStage, 'stale'),
    ];
    const { drs, restored } = backfillDrTerminalStatuses(input);
    expect(restored).toBe(3);
    expect(drs[0].status).toBe('closed_won');
    expect(drs[1].status).toBe('closed_lost');
    expect(drs[2].status).toBe('rejected');
  });

  it('leaves a genuinely withdrawn DR (open stage, no win evidence) untouched', () => {
    const genuine = corrupt(
      mergeDrBatch([], [rawDr({ opportunityId: '006Vy00001BKF005', stage: 'Discovery', probability: 0.1 })], [], 'b1', IMPORTED_AT).merged[0],
      'withdrawn',
    );
    const { drs, restored } = backfillDrTerminalStatuses([genuine]);
    expect(restored).toBe(0);
    expect(drs[0].status).toBe('withdrawn');
  });

  it('is idempotent — a second pass restores nothing and never downgrades a terminal record', () => {
    const input = [corrupt(wonViaStage, 'withdrawn'), corrupt(lostViaStage, 'active')];
    const once = backfillDrTerminalStatuses(input);
    expect(once.restored).toBe(2);
    const twice = backfillDrTerminalStatuses(once.drs);
    expect(twice.restored).toBe(0);
    expect(twice.drs.map(d => d.status)).toEqual(['closed_won', 'closed_lost']);
  });
});
