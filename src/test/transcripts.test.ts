import { describe, it, expect } from 'vitest';
import {
  parseExtractResponse, currentSignals, EMPTY_SIGNALS,
  type Transcript, type TranscriptSignals,
} from '@/lib/transcripts';

describe('parseExtractResponse', () => {
  it('parses a clean JSON object into validated signals', () => {
    const text = JSON.stringify({
      stakeholders: [{ name: 'Dana', role: 'CFO' }, { name: 'Lee', role: 'Champion' }],
      sentiment: 'positive',
      competitors: ['Acme', 'Globex'],
      commitments: ['Send order form'],
      risks: ['Budget freeze'],
    });
    expect(parseExtractResponse(text)).toEqual({
      stakeholders: [{ name: 'Dana', role: 'CFO' }, { name: 'Lee', role: 'Champion' }],
      sentiment: 'positive',
      competitors: ['Acme', 'Globex'],
      commitments: ['Send order form'],
      risks: ['Budget freeze'],
    });
  });

  it('tolerates surrounding prose / code fences', () => {
    const text = 'Here:\n```json\n{"sentiment":"negative","risks":["No budget"]}\n```';
    const s = parseExtractResponse(text);
    expect(s.sentiment).toBe('negative');
    expect(s.risks).toEqual(['No budget']);
    expect(s.stakeholders).toEqual([]); // missing → default
  });

  it('coerces a bad sentiment to neutral and drops malformed entries', () => {
    const text = JSON.stringify({
      stakeholders: [{ name: 'Ok', role: 'VP' }, { role: 'no name' }, 'nope', { name: '  ' }],
      sentiment: 'ecstatic',
      competitors: ['Acme', 42, null],
    });
    const s = parseExtractResponse(text);
    expect(s.stakeholders).toEqual([{ name: 'Ok', role: 'VP' }]); // only the valid one
    expect(s.sentiment).toBe('neutral');                          // invalid → neutral
    expect(s.competitors).toEqual(['Acme']);                      // non-strings dropped
  });

  it('returns EMPTY_SIGNALS on non-JSON', () => {
    expect(parseExtractResponse('sorry, no transcript')).toEqual(EMPTY_SIGNALS);
  });
});

describe('currentSignals', () => {
  const t = (id: string, createdAt: string, sentiment: TranscriptSignals['sentiment']): Transcript => ({
    id, oppId: 'o1', createdAt, rawText: '', signals: { ...EMPTY_SIGNALS, sentiment },
  });

  it('returns null for no transcripts', () => {
    expect(currentSignals([])).toBeNull();
  });

  it('picks the latest by createdAt regardless of array order', () => {
    const list = [
      t('a', '2026-06-01T10:00:00Z', 'positive'),
      t('c', '2026-06-03T10:00:00Z', 'negative'),
      t('b', '2026-06-02T10:00:00Z', 'neutral'),
    ];
    expect(currentSignals(list)?.sentiment).toBe('negative');
  });
});
