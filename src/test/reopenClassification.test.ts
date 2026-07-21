import { describe, it, expect } from 'vitest';
import { resolveImportedClassification, isOpenStage, isClosedWonLostStage, backfillReopenedClassifications } from '@/lib/forecastClassification';
import type { Opportunity } from '@/types/forecast';

const opp = (over: Partial<Opportunity>): Opportunity => ({
  id: '006Vy00000mao98', name: 'Deal', repId: '', repName: 'Rep', amount: 1000,
  closeDate: '2026-08-26', stage: 'Commercial', classification: 'lost', probability: 0.75,
  importDate: '2026-07-21T00:00:00.000Z', ...over,
});

describe('resolveImportedClassification — reopen clears stale omitted', () => {
  it('clears omitted when a Closed Won deal reopens on an open stage', () => {
    // existing: omitted + Closed Won stage; incoming: back on an open stage → 'commit'
    expect(resolveImportedClassification('omitted', 'commit', 'Closed Won', 'Negotiation')).toBe('commit');
  });

  it('clears omitted when a Closed Lost deal reopens, recomputing to incoming (unclassified)', () => {
    expect(resolveImportedClassification('omitted', 'unclassified', 'Closed Lost', 'Discovery')).toBe('unclassified');
  });

  it('clears a stale lost when a Closed Lost deal reopens on an open stage', () => {
    // The Alive Hospice case: SF marked it Closed Lost, then reopened it to Commercial (upside).
    expect(resolveImportedClassification('lost', 'upside', 'Closed Lost', 'Commercial')).toBe('upside');
  });

  it('clears a stale closed_won when a Closed Won deal reopens on an open stage', () => {
    expect(resolveImportedClassification('closed_won', 'commit', 'Closed Won', 'Negotiation')).toBe('commit');
  });

  it('keeps lost sticky when the stage stays closed (no reopen)', () => {
    expect(resolveImportedClassification('lost', 'commit', 'Closed Lost', 'Closed Lost')).toBe('lost');
  });

  it('keeps omitted sticky when the stage stays closed (no reopen)', () => {
    expect(resolveImportedClassification('omitted', 'commit', 'Closed Won', 'Closed Won')).toBe('omitted');
  });

  it('keeps omitted sticky when there is no stage evidence', () => {
    expect(resolveImportedClassification('omitted', 'commit')).toBe('omitted');
  });

  it('does not treat a blank incoming stage as a reopen', () => {
    expect(resolveImportedClassification('omitted', 'unclassified', 'Closed Won', '')).toBe('omitted');
  });

  it('does not reopen from a non-terminal existing stage', () => {
    // existing stage was already open — the omitted was a deliberate omit, keep it sticky
    expect(resolveImportedClassification('omitted', 'commit', 'Discovery', 'Negotiation')).toBe('omitted');
  });

  it('keeps closed_won sticky when there is no stage evidence (not a detectable reopen)', () => {
    expect(resolveImportedClassification('closed_won', 'commit')).toBe('closed_won');
  });
});

describe('stage helpers', () => {
  it('isClosedWonLostStage matches Closed Won/Lost (normalized), not Rejected/open', () => {
    expect(isClosedWonLostStage('Closed Won')).toBe(true);
    expect(isClosedWonLostStage('closed-lost')).toBe(true);
    expect(isClosedWonLostStage('Rejected')).toBe(false);
    expect(isClosedWonLostStage('Discovery')).toBe(false);
    expect(isClosedWonLostStage('')).toBe(false);
  });

  it('isOpenStage excludes terminal and blank stages', () => {
    expect(isOpenStage('Discovery')).toBe(true);
    expect(isOpenStage('Closed Won')).toBe(false);
    expect(isOpenStage('Closed Lost')).toBe(false);
    expect(isOpenStage('Rejected')).toBe(false);
    expect(isOpenStage('')).toBe(false);
    expect(isOpenStage(undefined)).toBe(false);
  });
});

describe('backfillReopenedClassifications — heal already-stranded reopens', () => {
  // Snapshot proving opp 006Vy00000mao98 was Closed Lost before it reopened.
  const priorClosed = [{ opportunityId: '006Vy00000mao98', stage: 'Closed Lost' }];

  it('resets a stale lost on an open stage (with prior-closed evidence) to unclassified', () => {
    const { opportunities, healed } = backfillReopenedClassifications([
      opp({ classification: 'lost', stage: 'Commercial', lostDate: '2026-06-24T00:00:00Z', lostReason: 'Closed Lost in Salesforce' }),
    ], priorClosed);
    expect(healed).toBe(1);
    expect(opportunities[0].classification).toBe('unclassified');
    expect(opportunities[0].previousClassification).toBe('lost');
    expect(opportunities[0].lostDate).toBeUndefined();
    expect(opportunities[0].lostReason).toBeUndefined();
  });

  it('heals stale omitted and closed_won on open stages when prior-closed evidence exists', () => {
    const { healed } = backfillReopenedClassifications([
      opp({ id: '006Vy00000mao98', salesforceId: '006Vy00000mao98', classification: 'omitted', stage: 'Qualified' }),
      opp({ id: '006Vy00000zzz01', salesforceId: '006Vy00000zzz01', classification: 'closed_won', stage: 'Negotiation' }),
    ], [
      { opportunityId: '006Vy00000mao98', stage: 'Closed Lost' },
      { opportunityId: '006Vy00000zzz01', stage: 'Closed Won' },
    ]);
    expect(healed).toBe(2);
  });

  it('spares an omitted deal that was NEVER closed (deliberate open omit, e.g. a test deal)', () => {
    const { opportunities, healed } = backfillReopenedClassifications([
      opp({ salesforceId: '006Vy00000test1', classification: 'omitted', stage: 'Technical' }),
    ], [{ opportunityId: '006Vy00000test1', stage: 'Technical' }]); // only ever open in history
    expect(healed).toBe(0);
    expect(opportunities[0].classification).toBe('omitted');
  });

  it('leaves genuinely closed-stage terminal deals untouched even with prior-closed history', () => {
    const { healed } = backfillReopenedClassifications([
      opp({ classification: 'lost', stage: 'Closed Lost' }),
    ], priorClosed);
    expect(healed).toBe(0);
  });

  it('leaves open non-terminal classifications untouched and is idempotent', () => {
    const input = [opp({ classification: 'upside', stage: 'Commercial' })];
    const once = backfillReopenedClassifications(input, priorClosed);
    expect(once.healed).toBe(0);
    const twice = backfillReopenedClassifications(once.opportunities, priorClosed);
    expect(twice.healed).toBe(0);
  });
});
