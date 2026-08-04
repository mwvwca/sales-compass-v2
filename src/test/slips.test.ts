import { describe, it, expect } from 'vitest';
import { computeSlips } from '@/lib/slips';
import type { Opportunity, ChangeLogEntry, OpportunitySnapshot } from '@/types/forecast';

const TODAY = new Date('2026-08-04T00:00:00Z');
const Q = '2026-Q2';

const opp = (over: Partial<Opportunity> & { id: string }): Opportunity => ({
  name: 'Deal', repId: '', repName: 'Rep A', amount: 100_000, closeDate: '2026-09-01',
  stage: 'Discovery', classification: 'commit', probability: 0.25, importDate: '2026-01-01',
  salesforceId: over.id, ...over,
});

const chg = (id: string, oldValue: string, newValue: string, importDate: string): ChangeLogEntry => ({
  id: `${id}-${importDate}`, importDate, fileName: 'f', opportunityId: id, opportunityName: 'Deal',
  repName: 'Rep A', field: 'closeDate', oldValue, newValue,
});

const snap = (id: string, closeDate: string, importDate: string): OpportunitySnapshot => ({
  opportunityId: id, importDate, fileName: 'f', amount: 100_000, closeDate, stage: 'Qualified',
  classification: 'commit', name: 'Deal', repName: 'Rep A',
});

describe('computeSlips — enriched slip metrics', () => {
  it('date-push slip: earliest-observed original, slip days, crossing, Reforecast action', () => {
    const o = opp({ id: '006Vy00000slip1', closeDate: '2026-07-15', stage: 'Discovery',
      resolvedReseller: 'Reseller X', productName: 'MDR', lastActivity: '2026-07-30' });
    const rows = computeSlips(
      [o],
      [chg('006Vy00000slip1', '2026-05-01', '2026-07-15', '2026-06-01T00:00:00Z')],
      [snap('006Vy00000slip1', '2026-04-10', '2026-03-01T00:00:00Z')], // earliest observed
      Q, TODAY,
    );
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.originalCloseDate).toBe('2026-04-10');       // from snapshot, not the push oldValue
    expect(r.originalQuarter).toBe('2026-Q2');
    expect(r.currentQuarter).toBe('2026-Q3');
    expect(r.crossesToLaterPeriod).toBe(true);
    expect(r.totalSlipDays).toBe(96);                     // 2026-04-10 → 2026-07-15
    expect(r.outwardMoveCount).toBe(1);
    expect(r.resolvedReseller).toBe('Reseller X');
    expect(r.productName).toBe('MDR');
    expect(r.isOpen).toBe(true);
    expect(r.suggestedAction).toBe('Reforecast');
  });

  it('three outward moves → Review for disqualification', () => {
    const rows = computeSlips(
      [opp({ id: '006Vy00000slip2', closeDate: '2026-09-01', lastActivity: '2026-08-01' })],
      [
        chg('006Vy00000slip2', '2026-05-01', '2026-07-01', '2026-06-01T00:00:00Z'),
        chg('006Vy00000slip2', '2026-07-01', '2026-08-01', '2026-06-15T00:00:00Z'),
        chg('006Vy00000slip2', '2026-08-01', '2026-09-01', '2026-07-01T00:00:00Z'),
      ],
      [], Q, TODAY,
    );
    expect(rows[0].outwardMoveCount).toBe(3);
    expect(rows[0].suggestedAction).toBe('Review for disqualification');
  });

  it('stale activity (≥ 30d) → Review for disqualification even on a single move', () => {
    const rows = computeSlips(
      [opp({ id: '006Vy00000slip3', closeDate: '2026-07-10', lastActivity: '2026-05-01' })],
      [chg('006Vy00000slip3', '2026-05-15', '2026-07-10', '2026-06-01T00:00:00Z')],
      [], Q, TODAY,
    );
    expect(rows[0].outwardMoveCount).toBe(1);
    expect(rows[0].daysSinceActivity).toBeGreaterThanOrEqual(30);
    expect(rows[0].suggestedAction).toBe('Review for disqualification');
  });

  it('stage-strict isOpen is false for a closed-stage slip (open-only filter would drop it)', () => {
    const rows = computeSlips(
      [opp({ id: '006Vy00000slip4', closeDate: '2026-07-20', stage: 'Closed Won', classification: 'closed_won' })],
      [chg('006Vy00000slip4', '2026-05-01', '2026-07-20', '2026-06-01T00:00:00Z')],
      [], Q, TODAY,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].isOpen).toBe(false);
  });
});
