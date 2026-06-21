import { describe, it, expect } from 'vitest';
import { parseCoachResponse } from '@/lib/coach1on1';

describe('parseCoachResponse', () => {
  const ids = new Set(['a', 'b']);

  it('parses a clean response and keeps only known ids + valid verdicts', () => {
    const r = parseCoachResponse(JSON.stringify({
      deals: [
        { id: 'a', crux: 'partner sells a competitor', verdict: 'unaddressed-risk', challenge: 'ask the partner directly' },
        { id: 'zzz', crux: 'x', verdict: 'advances', challenge: 'y' }, // unknown id dropped
        { id: 'b', crux: 'no economic buyer', verdict: 'nonsense', challenge: 'z' }, // bad verdict dropped
      ],
      themes: ['single-threaded through partners', '', '  thin discovery  '],
    }), ids);
    expect(r.deals).toHaveLength(1);
    expect(r.deals[0]).toMatchObject({ id: 'a', verdict: 'unaddressed-risk' });
    expect(r.themes).toEqual(['single-threaded through partners', 'thin discovery']);
  });

  it('tolerates code fences and surrounding prose', () => {
    const r = parseCoachResponse('Here you go:\n```json\n{"deals":[{"id":"b","crux":"c","verdict":"activity","challenge":"ch"}],"themes":[]}\n```', ids);
    expect(r.deals).toHaveLength(1);
    expect(r.deals[0].id).toBe('b');
  });

  it('returns empty on garbage', () => {
    expect(parseCoachResponse('not json', ids)).toEqual({ deals: [], themes: [] });
  });
});
