import { describe, it, expect } from 'vitest';
import {
  buildChangelogIndex, dealRiskSignals, flagDeal, STALE_DAYS, PUSH_FLAG_MIN,
} from '@/lib/dealRisk';
import type { Opportunity, ChangeLogEntry } from '@/types/forecast';

const TODAY = new Date('2026-06-30T00:00:00Z');
const daysAgo = (n: number) => new Date(TODAY.getTime() - n * 86_400_000).toISOString().slice(0, 10);

function opp(over: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'o1', name: 'Deal', repId: '', repName: 'Jane', amount: 1000, closeDate: '2026-09-30',
    stage: 'Discovery', classification: 'commit', probability: 0.6, importDate: daysAgo(1),
    ...over,
  } as Opportunity;
}
function cl(over: Partial<ChangeLogEntry> = {}): ChangeLogEntry {
  return {
    id: 'c', importDate: daysAgo(1), fileName: 'f', opportunityId: 'o1', opportunityName: 'Deal',
    repName: 'Jane', field: 'closeDate', oldValue: '2026-03-31', newValue: '2026-06-30',
    ...over,
  } as ChangeLogEntry;
}

describe('dealRisk signals', () => {
  it('buildChangelogIndex groups entries by opportunity id', () => {
    const idx = buildChangelogIndex([cl({ opportunityId: 'a' }), cl({ opportunityId: 'a' }), cl({ opportunityId: 'b' })]);
    expect(idx.get('a')).toHaveLength(2);
    expect(idx.get('b')).toHaveLength(1);
    expect(idx.get('c')).toBeUndefined();
  });

  it('pushCount counts only closeDate changes with both old and new values', () => {
    const idx = buildChangelogIndex([
      cl({ field: 'closeDate', oldValue: 'a', newValue: 'b' }),
      cl({ field: 'closeDate', oldValue: 'b', newValue: 'c' }),
      cl({ field: 'amount', oldValue: '1', newValue: '2' }),   // wrong field
      cl({ field: 'closeDate', oldValue: '', newValue: 'x' }), // missing oldValue
    ]);
    expect(dealRiskSignals(opp(), idx, TODAY).pushCount).toBe(2);
  });

  it('daysSinceMovement uses the latest changelog import, falling back to importDate', () => {
    expect(dealRiskSignals(opp({ importDate: daysAgo(12) }), buildChangelogIndex([]), TODAY).daysSinceMovement).toBe(12);
    const idx = buildChangelogIndex([cl({ importDate: daysAgo(40) }), cl({ importDate: daysAgo(3) })]);
    expect(dealRiskSignals(opp({ importDate: daysAgo(100) }), idx, TODAY).daysSinceMovement).toBe(3);
  });
});

describe('flagDeal thresholds', () => {
  const empty = buildChangelogIndex([]);

  it('pushed fires at PUSH_FLAG_MIN closeDate pushes, not below', () => {
    expect(PUSH_FLAG_MIN).toBe(2);
    const two = buildChangelogIndex([cl({ importDate: daysAgo(1) }), cl({ importDate: daysAgo(1) })]);
    const one = buildChangelogIndex([cl({ importDate: daysAgo(1) })]);
    expect(flagDeal(opp(), two, TODAY).map(f => f.kind)).toContain('pushed');
    expect(flagDeal(opp(), one, TODAY).map(f => f.kind)).not.toContain('pushed');
  });

  it('stalled fires exactly at the STALE_DAYS boundary, not one day under', () => {
    expect(STALE_DAYS).toBe(30);
    expect(flagDeal(opp({ importDate: daysAgo(30) }), empty, TODAY).map(f => f.kind)).toContain('stalled');
    expect(flagDeal(opp({ importDate: daysAgo(29) }), empty, TODAY).map(f => f.kind)).not.toContain('stalled');
  });

  it('under_qualified fires below the 0.25 SQL floor, not at/above it', () => {
    expect(flagDeal(opp({ probability: 0.1, importDate: daysAgo(1), nextStep: 'x' }), empty, TODAY).map(f => f.kind)).toContain('under_qualified');
    expect(flagDeal(opp({ probability: 0.25, importDate: daysAgo(1), nextStep: 'x' }), empty, TODAY).map(f => f.kind)).not.toContain('under_qualified');
  });

  it('no_next_step fires on a blank/whitespace next step, not when one is present', () => {
    const fresh = { probability: 0.6, importDate: daysAgo(1) };
    expect(flagDeal(opp({ ...fresh, nextStep: undefined }), empty, TODAY).map(f => f.kind)).toContain('no_next_step');
    expect(flagDeal(opp({ ...fresh, nextStep: '' }), empty, TODAY).map(f => f.kind)).toContain('no_next_step');
    expect(flagDeal(opp({ ...fresh, nextStep: '   ' }), empty, TODAY).map(f => f.kind)).toContain('no_next_step');
    expect(flagDeal(opp({ ...fresh, nextStep: 'Call the CFO' }), empty, TODAY).map(f => f.kind)).not.toContain('no_next_step');
  });

  it('emits no populated flags for a fresh, qualified, never-pushed deal with a next step', () => {
    expect(flagDeal(opp({ probability: 0.6, importDate: daysAgo(1), nextStep: 'Schedule demo' }), empty, TODAY)).toEqual([]);
  });

  it('competitor_present and risk_flagged fire from transcript signals, and not when empty', () => {
    const signals = { stakeholders: [{ name: 'A', role: 'IT' }, { name: 'B', role: 'Sec' }], sentiment: 'neutral' as const, competitors: ['Arctic Wolf'], commitments: [], risks: ['budget not confirmed'] };
    const kinds = flagDeal(opp({ nextStep: 'x' }), empty, TODAY, undefined, signals).map(f => f.kind);
    expect(kinds).toContain('competitor_present');
    expect(kinds).toContain('risk_flagged');
    const none = flagDeal(opp({ nextStep: 'x' }), empty, TODAY, undefined, { ...signals, competitors: [], risks: [] }).map(f => f.kind);
    expect(none).not.toContain('competitor_present');
    expect(none).not.toContain('risk_flagged');
  });
});
