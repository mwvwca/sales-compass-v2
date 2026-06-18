import { describe, it, expect } from 'vitest';
import { mergeDrBatch } from '@/lib/drMerge';
import type { RawDrRecord, Opportunity } from '@/types/forecast';

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
