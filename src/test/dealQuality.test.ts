import { describe, it, expect } from 'vitest';
import { computeDealQualityCore, MIN_RESOLVED } from '@/lib/dealQuality';
import type { DealRegistration, DrStatus } from '@/types/forecast';

// Minimal DR factory — only the fields computeDealQualityCore reads.
function dr(status: DrStatus, opts: { sqlDate?: string } = {}): DealRegistration {
  return {
    status,
    sqlDate: opts.sqlDate,
    stageHistory: [],
  } as unknown as DealRegistration;
}

describe('computeDealQualityCore', () => {
  it('counts win rate over ALL resolved deals, not just SQL-gated ones', () => {
    // Two already-closed deals with NO sqlDate and NO open SQL stage history:
    // these would be excluded by an everReachedSql gate, but must count here.
    const drs = [
      dr('closed_won'),
      dr('closed_won'),
      dr('closed_lost'),
      dr('active'),
    ];
    const c = computeDealQualityCore(drs);
    expect(c.resolvedCount).toBe(3);
    expect(c.closedWonR).toBe(2);
    expect(c.winRate).toBeCloseTo(2 / 3);
  });

  it('returns winRate null when nothing has resolved', () => {
    const c = computeDealQualityCore([dr('active'), dr('sql', { sqlDate: '2026-01-01' })]);
    expect(c.winRate).toBeNull();
    expect(c.resolvedCount).toBe(0);
  });

  it('excludes rejected from total but cohort rate uses total', () => {
    const drs = [dr('closed_won'), dr('active'), dr('rejected')];
    const c = computeDealQualityCore(drs);
    expect(c.total).toBe(2); // rejected excluded
    expect(c.closedWon).toBe(1);
    expect(c.overallCohortRate).toBeCloseTo(1 / 2);
  });

  it('computes sqlRate from everReachedSql (sqlDate or open SQL stage history)', () => {
    const drs = [
      dr('sql', { sqlDate: '2026-01-01' }),
      dr('active'),
      dr('active'),
      dr('active'),
    ];
    const c = computeDealQualityCore(drs);
    expect(c.reachedSQL).toBe(1);
    expect(c.sqlRate).toBeCloseTo(1 / 4);
  });

  it('handles an empty slice without dividing by zero', () => {
    const c = computeDealQualityCore([]);
    expect(c).toMatchObject({ total: 0, reachedSQL: 0, sqlRate: 0, resolvedCount: 0, winRate: null, overallCohortRate: 0 });
  });

  it('exposes a shared MIN_RESOLVED gate', () => {
    expect(MIN_RESOLVED).toBe(10);
  });
});
