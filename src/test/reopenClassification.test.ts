import { describe, it, expect } from 'vitest';
import { resolveImportedClassification, isOpenStage, isClosedWonLostStage, backfillReopenedClassifications } from '@/lib/forecastClassification';
import type { Opportunity } from '@/types/forecast';

const opp = (over: Partial<Opportunity>): Opportunity => ({
  id: '006Vy00000mao98', name: 'Deal', repId: '', repName: 'Rep', amount: 1000,
  closeDate: '2026-08-26', stage: 'Commercial', classification: 'lost', probability: 0.75,
  importDate: '2026-07-21T00:00:00.000Z', ...over,
});

describe('resolveImportedClassification — a stage change clears a stale terminal class', () => {
  it('clears lost on a Closed Lost → open reopen (recomputes from incoming)', () => {
    expect(resolveImportedClassification('lost', 'upside', 'Closed Lost', 'Commercial')).toBe('upside');
  });

  it('clears closed_won on a Closed Won → open reopen', () => {
    expect(resolveImportedClassification('closed_won', 'commit', 'Closed Won', 'Negotiation')).toBe('commit');
  });

  it('clears rejected on a Rejected → Discovery stage change', () => {
    expect(resolveImportedClassification('rejected', 'unclassified', 'Rejected', 'Discovery')).toBe('unclassified');
  });

  it('clears a stale lost on an open → open stage change (not only closed → open)', () => {
    expect(resolveImportedClassification('lost', 'commit', 'Discovery', 'Technical')).toBe('commit');
  });

  it('keeps lost sticky when the stage is unchanged', () => {
    expect(resolveImportedClassification('lost', 'commit', 'Closed Lost', 'Closed Lost')).toBe('lost');
  });

  it('never wipes a manual commit/upside on a stage change (not a terminal state)', () => {
    // commit is not terminal → the stage-change clear must not touch it; incoming unclassified
    // falls through to preserve the existing commit.
    expect(resolveImportedClassification('commit', 'unclassified', 'Discovery', 'Technical', 0.5)).toBe('commit');
    expect(resolveImportedClassification('upside', 'unclassified', 'Discovery', 'Technical', 0.5)).toBe('upside');
  });
});

describe('resolveImportedClassification — omitted clears only on a QUALIFIED stage change', () => {
  it('clears omitted on a stage change when the incoming record is qualified (≥ 0.25)', () => {
    expect(resolveImportedClassification('omitted', 'unclassified', 'Qualified', 'Discovery', 0.25)).toBe('unclassified');
  });

  it('keeps omitted on a stage change when the record is BELOW qualification', () => {
    expect(resolveImportedClassification('omitted', 'unclassified', 'Qualified', 'Discovery', 0.05)).toBe('omitted');
  });

  it('keeps omitted sticky when the stage is unchanged (even if qualified)', () => {
    expect(resolveImportedClassification('omitted', 'commit', 'Commercial', 'Commercial', 0.75)).toBe('omitted');
  });

  it('keeps omitted sticky when there is no stage evidence', () => {
    expect(resolveImportedClassification('omitted', 'commit')).toBe('omitted');
  });

  it('does not treat a blank incoming stage as a stage change', () => {
    expect(resolveImportedClassification('omitted', 'unclassified', 'Closed Won', '', 0.9)).toBe('omitted');
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

describe('backfillReopenedClassifications — heal already-stranded records', () => {
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

  it('heals a stranded omitted on a QUALIFIED open stage — no prior-closed evidence needed', () => {
    // The Mid-America / Savage case: omitted while open, never actually closed, but qualified.
    const { opportunities, healed } = backfillReopenedClassifications([
      opp({ salesforceId: '006Vy00000mid01', classification: 'omitted', stage: 'Technical', probability: 0.5 }),
    ], []); // no snapshots at all
    expect(healed).toBe(1);
    expect(opportunities[0].classification).toBe('unclassified');
    expect(opportunities[0].previousClassification).toBe('omitted');
  });

  it('spares an omitted open deal BELOW qualification (deliberate omit of an early/junk deal)', () => {
    const { opportunities, healed } = backfillReopenedClassifications([
      opp({ salesforceId: '006Vy00000low01', classification: 'omitted', stage: 'Qualified', probability: 0.05 }),
    ], []);
    expect(healed).toBe(0);
    expect(opportunities[0].classification).toBe('omitted');
  });

  it('spares a lost/closed_won open deal that was NEVER closed (no snapshot evidence)', () => {
    const { healed } = backfillReopenedClassifications([
      opp({ salesforceId: '006Vy00000rem01', classification: 'lost', stage: 'Qualified', probability: 0.5 }),
    ], []); // no Closed snapshot → not a confirmed reopen
    expect(healed).toBe(0);
  });

  it('leaves genuinely closed-stage terminal deals untouched', () => {
    const { healed } = backfillReopenedClassifications([
      opp({ classification: 'lost', stage: 'Closed Lost' }),
      opp({ salesforceId: '006Vy00000om02', classification: 'omitted', stage: 'Closed Won', probability: 0.9 }),
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

describe('backfillReopenedClassifications — provenance guard (protects manual calls on re-run)', () => {
  const manualClass = (opportunityId: string, newValue: string, importDate: string) => ({
    opportunityId, field: 'classification', newValue, importDate, fileName: '(manual)',
  });

  it('does NOT heal a qualified open omitted deal a manager set manually', () => {
    const o = opp({ salesforceId: '006Vy00000man01', classification: 'omitted', stage: 'Technical', probability: 0.5 });
    const { healed, opportunities } = backfillReopenedClassifications(
      [o], [], [manualClass('006Vy00000man01', 'omitted', '2026-08-01T00:00:00Z')],
    );
    expect(healed).toBe(0);
    expect(opportunities[0].classification).toBe('omitted');
  });

  it('still heals a derived (non-manual) stranded omitted with no manual changelog', () => {
    const o = opp({ salesforceId: '006Vy00000der01', classification: 'omitted', stage: 'Technical', probability: 0.5 });
    const { healed } = backfillReopenedClassifications([o], [], []); // no manual provenance
    expect(healed).toBe(1);
  });

  it('uses the LATEST manual entry — heals when the manager later moved off the protected value', () => {
    // Manager set omitted, then manually moved it to commit; current is omitted again via import churn.
    // Latest manual call was 'commit' (not the current 'omitted'), so the omit is not a live manual call → heal.
    const o = opp({ salesforceId: '006Vy00000lat01', classification: 'omitted', stage: 'Technical', probability: 0.5 });
    const { healed } = backfillReopenedClassifications([o], [], [
      manualClass('006Vy00000lat01', 'omitted', '2026-07-01T00:00:00Z'),
      manualClass('006Vy00000lat01', 'commit', '2026-08-01T00:00:00Z'),
    ]);
    expect(healed).toBe(1);
  });

  it('protects a manually-set closed_won on an open stage even with prior-close evidence', () => {
    const o = opp({ salesforceId: '006Vy00000man02', classification: 'closed_won', stage: 'Commercial' });
    const priorClosed = [{ opportunityId: '006Vy00000man02', stage: 'Closed Won' }];
    const { healed } = backfillReopenedClassifications(
      [o], priorClosed, [manualClass('006Vy00000man02', 'closed_won', '2026-08-05T00:00:00Z')],
    );
    expect(healed).toBe(0);
  });
});
