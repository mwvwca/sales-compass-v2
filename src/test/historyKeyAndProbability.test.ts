import { describe, it, expect } from 'vitest';
import { historyKey, matchesHistoryKey, rowsForOpportunity } from '@/lib/historyKey';
import { normalizeProbability } from '@/lib/probability';
import { buildChangelogIndex, dealRiskSignals, slipProfile } from '@/lib/dealRisk';
import type { ChangeLogEntry, Opportunity } from '@/types/forecast';

const uuidOpp = {
  id: '3f9c2a10-1111-4222-8333-abcdefabcdef',
  salesforceId: '006Vy0000AAAABBBCC',
  name: 'UUID Deal',
  repId: '',
  repName: 'Sarah Winters',
  amount: 10000,
  closeDate: '2026-08-15',
  stage: 'Discovery',
  classification: 'upside',
  probability: 0.25,
  importDate: '2026-05-01T00:00:00.000Z',
} as Opportunity;

const entry = (over: Partial<ChangeLogEntry>): ChangeLogEntry => ({
  id: crypto.randomUUID(),
  importDate: '2026-06-30T00:00:00.000Z',
  fileName: 'x.xlsx',
  opportunityId: uuidOpp.salesforceId!,
  opportunityName: uuidOpp.name,
  repName: uuidOpp.repName,
  field: 'closeDate',
  oldValue: '2026-07-01',
  newValue: '2026-08-15',
  ...over,
});

describe('F1: history keyed by Salesforce id resolves for UUID-id opportunities', () => {
  it('historyKey prefers salesforceId and falls back to id', () => {
    expect(historyKey(uuidOpp)).toBe('006Vy0000AAAABBBCC');
    expect(historyKey({ id: 'abc' })).toBe('abc');
  });

  it('matchesHistoryKey accepts either key', () => {
    expect(matchesHistoryKey(uuidOpp.salesforceId!, uuidOpp)).toBe(true);
    expect(matchesHistoryKey(uuidOpp.id, uuidOpp)).toBe(true);
    expect(matchesHistoryKey('006Vy0000ZZZZZZZZZ', uuidOpp)).toBe(false);
  });

  it('rowsForOpportunity merges rows under both keys without duplication', () => {
    const index = new Map<string, number[]>([
      [uuidOpp.salesforceId!, [1, 2]],
      [uuidOpp.id, [3]],
    ]);
    expect(rowsForOpportunity(index, uuidOpp)).toEqual([1, 2, 3]);
    // SF-id-keyed opp (id === salesforceId) must not double-count
    const sfOpp = { id: '006Vy0000AAAABBBCC', salesforceId: '006Vy0000AAAABBBCC' };
    expect(rowsForOpportunity(index, sfOpp)).toEqual([1, 2]);
  });

  it('dealRiskSignals sees pushes recorded under the Salesforce id (the pre-fix blind spot)', () => {
    const index = buildChangelogIndex([
      entry({}),
      entry({ oldValue: '2026-08-15', newValue: '2026-09-30' }),
    ]);
    const { pushCount } = dealRiskSignals(uuidOpp, index, new Date('2026-07-03'));
    expect(pushCount).toBe(2);
  });

  it('slipProfile computes drift from Salesforce-keyed entries', () => {
    const index = buildChangelogIndex([
      entry({ importDate: '2026-06-01T00:00:00.000Z', oldValue: '2026-07-01', newValue: '2026-08-15' }),
    ]);
    const p = slipProfile(uuidOpp, index);
    expect(p.slips).toBe(1);
    expect(p.slipDays).toBeGreaterThan(0);
  });
});

describe('F2: probability normalization', () => {
  it('leaves fraction-scale values alone', () => {
    expect(normalizeProbability(0.25)).toBe(0.25);
    expect(normalizeProbability(0.05)).toBe(0.05);
    expect(normalizeProbability(1)).toBe(1);
  });

  it('converts percent-scale values to fractions', () => {
    expect(normalizeProbability(25)).toBe(0.25);
    expect(normalizeProbability(5)).toBe(0.05);
    expect(normalizeProbability(100)).toBe(1);
  });

  it('parses strings and clamps garbage', () => {
    expect(normalizeProbability('50')).toBe(0.5);
    expect(normalizeProbability('')).toBe(0);
    expect(normalizeProbability(undefined)).toBe(0);
    expect(normalizeProbability(-3)).toBe(0);
    expect(normalizeProbability(250)).toBe(1);
  });
});
