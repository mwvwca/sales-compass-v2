import { describe, it, expect } from 'vitest';
import {
  reconcileQuote,
  quoteDrift,
  formatDivisor,
  likelyCauseHint,
} from '@/lib/quoteReconciliation';
import type { OpportunitySnapshot } from '@/types/forecast';

const q = (amount: number, amountMonthly: number | null | undefined) =>
  reconcileQuote({ amount, amountMonthly });

function snap(over: Partial<OpportunitySnapshot> & { importDate: string }): OpportunitySnapshot {
  return {
    opportunityId: '006Vy00001L1ubS', fileName: 'f.xlsx', amount: 1000,
    closeDate: '2026-09-30', stage: 'Commercial', classification: 'commit',
    name: 'Opp', repName: 'Rep One', ...over,
  };
}

// The three disagreements confirmed in the 2026-08-31 export.
describe('confirmed 2026-08-31 export cases', () => {
  it('006Vy00001L1ubS — Amount 185,598 vs Monthly 61,866 flags at divisor 3.0', () => {
    const r = q(185598.0, 61866.0);
    expect(r.state).toBe('quoted-mismatch');
    expect(r.impliedDivisor).toBeCloseTo(3.0, 10);
    expect(formatDivisor(r.impliedDivisor!)).toBe('3.0');
    expect(r.monthlyAnnualized).toBeCloseTo(742392, 6);
    // A divisor of 3 is NOT a 36-month TCV read (that would be 36.0). Amount holds only
    // a quarter of the annual value Monthly implies, so it lands in the understated band.
    expect(r.likelyCause).toMatch(/only ~3\.0× Monthly/);
    expect(r.likelyCause).not.toMatch(/TCV/);
  });

  it('006Vy00000vD63b — Amount 2,000 vs Monthly 24,000 reads as inverted', () => {
    const r = q(2000.0, 24000.0);
    expect(r.state).toBe('quoted-mismatch');
    expect(formatDivisor(r.impliedDivisor!)).toBe('0.08');
    expect(r.likelyCause).toMatch(/inverted/);
  });

  it('006Vy00001CUjQ5 — Amount 18,000 vs Monthly 15,000 flags at divisor 1.2', () => {
    const r = q(18000.0, 15000.0);
    expect(r.state).toBe('quoted-mismatch');
    expect(formatDivisor(r.impliedDivisor!)).toBe('1.2');
    expect(r.likelyCause).toMatch(/only ~1\.2× Monthly/);
  });
});

describe('quoted-clean', () => {
  it('24,999.96 vs 2,083.33 is within tolerance', () => {
    const r = q(24999.96, 2083.33);
    expect(r.state).toBe('quoted-clean');
    expect(r.likelyCause).toBeNull();
  });

  it('a sub-cent gap on a large deal is not a signal (absolute floor)', () => {
    expect(q(1200000, 100000.01).state).toBe('quoted-clean');
  });

  it('a gap under 0.5% of Amount/12 is not a signal (relative floor)', () => {
    // expected 100.00, gap 0.40 — clears the $0.02 floor but not the 0.5% ($0.50) floor.
    expect(q(1200, 100.4).state).toBe('quoted-clean');
  });

  it('a gap clearing both floors is a mismatch', () => {
    expect(q(1200, 100.6).state).toBe('quoted-mismatch');
  });
});

describe('unquoted', () => {
  it('a blank Monthly with an Amount present is unquoted, never a mismatch', () => {
    const r = q(50000, null);
    expect(r.state).toBe('unquoted');
    expect(r.likelyCause).toBeNull();
    expect(r.impliedDivisor).toBeNull();
  });

  it('an undefined Monthly (column absent from the export) is unquoted', () => {
    expect(q(50000, undefined).state).toBe('unquoted');
  });

  it('a zero Monthly is unquoted, not a mismatch against Amount', () => {
    expect(q(50000, 0).state).toBe('unquoted');
  });

  it('neither field usable is unknown, so nothing renders', () => {
    expect(q(0, 0).state).toBe('unknown');
    expect(q(0, null).state).toBe('unknown');
  });
});

describe('likely-cause bands', () => {
  it('names the term when the divisor is near an integer in 13–60', () => {
    expect(likelyCauseHint(36, 180000)).toBe('Amount may be TCV (approx 36-month term)');
    expect(likelyCauseHint(35.7, 180000)).toBe('Amount may be TCV (approx 36-month term)');
  });

  it('reads a near-12 divisor as a stale Monthly', () => {
    expect(likelyCauseHint(12.24, 120000)).toMatch(/stale from a prior quote/);
    expect(likelyCauseHint(11.5, 120000)).toMatch(/stale from a prior quote/);
  });

  it('covers the below-11 gap the 13–60 TCV band leaves open', () => {
    expect(likelyCauseHint(3, 185598)).toMatch(/only ~3\.0× Monthly/);
    expect(likelyCauseHint(10.9, 100000)).toMatch(/only ~10\.9× Monthly/);
  });

  it('flags an implausible multiple beyond 60 months', () => {
    expect(likelyCauseHint(120, 100000)).toMatch(/beyond any plausible contract term/);
  });

  it('calls out a blank Amount alongside a real Monthly', () => {
    expect(likelyCauseHint(0, 0)).toMatch(/Amount is blank or zero/);
  });
});

describe('quoteDrift', () => {
  it('reports Amount moving while Monthly held', () => {
    const d = quoteDrift([
      snap({ importDate: '2026-08-01', amount: 61866 * 12, amountMonthly: 61866 }),
      snap({ importDate: '2026-08-15', amount: 185598, amountMonthly: 61866 }),
      snap({ importDate: '2026-08-31', amount: 185598, amountMonthly: 61866 }),
    ]);
    expect(d?.moved).toBe('amount');
    expect(d?.at).toBe('2026-08-15');
    expect(d?.note).toMatch(/Amount changed on Aug 15, 2026 without a Monthly update/);
  });

  it('reports Monthly moving while Amount held', () => {
    const d = quoteDrift([
      snap({ importDate: '2026-08-01', amount: 185598, amountMonthly: 15466.5 }),
      snap({ importDate: '2026-08-31', amount: 185598, amountMonthly: 61866 }),
    ]);
    expect(d?.moved).toBe('monthly');
    expect(d?.note).toMatch(/Monthly changed on Aug 31, 2026 without an Amount update/);
  });

  it('returns nothing until Monthly has two observations — no retroactive claims', () => {
    // Snapshots written before amountMonthly existed carry `undefined`, which means
    // "not observed" and must never be read as "Monthly held".
    const d = quoteDrift([
      snap({ importDate: '2026-08-01', amount: 100000 }),
      snap({ importDate: '2026-08-15', amount: 100000 }),
      snap({ importDate: '2026-08-31', amount: 185598, amountMonthly: 61866 }),
    ]);
    expect(d).toBeNull();
  });

  it('returns nothing when both fields moved in the same import', () => {
    const d = quoteDrift([
      snap({ importDate: '2026-08-01', amount: 100000, amountMonthly: 8333.33 }),
      snap({ importDate: '2026-08-31', amount: 185598, amountMonthly: 61866 }),
    ]);
    expect(d).toBeNull();
  });

  it('returns nothing when neither field ever moved', () => {
    const d = quoteDrift([
      snap({ importDate: '2026-08-01', amount: 185598, amountMonthly: 61866 }),
      snap({ importDate: '2026-08-31', amount: 185598, amountMonthly: 61866 }),
    ]);
    expect(d).toBeNull();
  });
});
