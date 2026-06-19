import { describe, it, expect } from 'vitest';
import {
  hashText, selectChangedDeals, mergeClassifications, qualityFor, parseClassifyResponse,
  type NextStepCache,
} from '@/lib/nextStepClassify';
import { flagDeal, buildChangelogIndex } from '@/lib/dealRisk';
import type { Opportunity } from '@/types/forecast';

function opp(over: Partial<Opportunity> & { id: string }): Opportunity {
  return {
    name: `Deal ${over.id}`, repId: '', repName: 'Jane', amount: 1000, closeDate: '2026-09-30',
    stage: 'Discovery', classification: 'commit', probability: 0.6, importDate: '2026-06-18',
    ...over,
  } as Opportunity;
}

describe('hashText', () => {
  it('is stable and whitespace-insensitive at the edges', () => {
    expect(hashText('Call the CFO')).toBe(hashText('  Call the CFO  '));
    expect(hashText('a')).not.toBe(hashText('b'));
  });
});

describe('selectChangedDeals — cost control', () => {
  const cache: NextStepCache = { o1: { quality: 'concrete', isDated: false, hash: hashText('Send proposal') } };

  it('selects open deals whose non-empty next step changed; skips unchanged/empty/closed', () => {
    const opps = [
      opp({ id: 'o1', nextStep: 'Send proposal' }),                       // unchanged → skip
      opp({ id: 'o2', nextStep: 'Follow up' }),                           // new → select
      opp({ id: 'o3', nextStep: '   ' }),                                 // empty → skip
      opp({ id: 'o4', nextStep: 'Demo booked', classification: 'closed_won' }), // closed → skip
      opp({ id: 'o1b', nextStep: 'Send updated proposal' }),             // (different id) changed → select
    ];
    // o1 with new text should also be selected:
    opps.push(opp({ id: 'o1', nextStep: 'Send proposal v2' }));
    const ids = selectChangedDeals(opps, cache).map(i => i.oppId).sort();
    expect(ids).toEqual(['o1', 'o1b', 'o2']);
  });
});

describe('mergeClassifications + qualityFor', () => {
  it('stamps results with the current hash; qualityFor trusts only matching text', () => {
    const items = [{ oppId: 'o2', text: 'Follow up' }];
    const cache = mergeClassifications({}, items, { o2: { quality: 'vague', isDated: false } });
    expect(cache.o2).toEqual({ quality: 'vague', isDated: false, hash: hashText('Follow up') });

    expect(qualityFor(opp({ id: 'o2', nextStep: 'Follow up' }), cache)).toBe('vague');
    // text changed since classification → cache no longer trusted
    expect(qualityFor(opp({ id: 'o2', nextStep: 'Send the signed order form' }), cache)).toBeUndefined();
  });
});

describe('parseClassifyResponse', () => {
  const ids = new Set(['o1', 'o2']);
  it('parses a clean JSON array, ignoring unknown ids and bad rows', () => {
    const text = '[{"id":"o1","quality":"concrete","isDated":true},{"id":"o2","quality":"vague","isDated":false},{"id":"x","quality":"vague"}]';
    expect(parseClassifyResponse(text, ids)).toEqual({
      o1: { quality: 'concrete', isDated: true },
      o2: { quality: 'vague', isDated: false },
    });
  });
  it('tolerates surrounding prose / code fences', () => {
    const text = 'Here you go:\n```json\n[{"id":"o1","quality":"vague","isDated":false}]\n```';
    expect(parseClassifyResponse(text, ids)).toEqual({ o1: { quality: 'vague', isDated: false } });
  });
  it('returns {} on non-JSON', () => {
    expect(parseClassifyResponse('sorry, no', ids)).toEqual({});
  });
});

describe('flagDeal vague_next_step', () => {
  const empty = buildChangelogIndex([]);
  const TODAY = new Date('2026-06-18T00:00:00Z');
  const fresh = { importDate: '2026-06-17', probability: 0.6 };

  it('adds vague_next_step only when a non-empty next step is classified vague', () => {
    expect(flagDeal(opp({ id: 'a', ...fresh, nextStep: 'Follow up' }), empty, TODAY, 'vague').map(f => f.kind)).toContain('vague_next_step');
    expect(flagDeal(opp({ id: 'b', ...fresh, nextStep: 'Send order form' }), empty, TODAY, 'concrete').map(f => f.kind)).not.toContain('vague_next_step');
    // empty next step → no_next_step, never vague (even if a stray quality is passed)
    const emptyFlags = flagDeal(opp({ id: 'c', ...fresh, nextStep: '' }), empty, TODAY, 'vague').map(f => f.kind);
    expect(emptyFlags).toContain('no_next_step');
    expect(emptyFlags).not.toContain('vague_next_step');
    // no classification supplied → no vague flag
    expect(flagDeal(opp({ id: 'd', ...fresh, nextStep: 'Follow up' }), empty, TODAY).map(f => f.kind)).not.toContain('vague_next_step');
  });
});
