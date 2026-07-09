import { describe, it, expect } from 'vitest';
import { computeHudPipe } from '@/lib/forecastClassification';
import type { Opportunity } from '@/types/forecast';

// Minimal factory — only the fields computeHudPipe reads (classification, stage, amount) matter;
// the rest satisfy the Opportunity type.
function opp(partial: Partial<Opportunity> & { amount: number; classification: Opportunity['classification'] }): Opportunity {
  return {
    id: Math.random().toString(36).slice(2),
    name: 'Deal',
    repId: 'r1',
    repName: 'Rep One',
    closeDate: '2026-05-15',
    stage: 'Discovery',
    probability: 0.5,
    importDate: '2026-05-01',
    ...partial,
  };
}

describe('computeHudPipe — Starting Pipe reconciliation', () => {
  // A scoped set spanning every outcome plus deals that must be excluded from totals.
  const scoped: Opportunity[] = [
    opp({ classification: 'unclassified', amount: 100_000 }),                       // open
    opp({ classification: 'commit', amount: 50_000 }),                              // open (commit)
    opp({ classification: 'upside', amount: 30_000 }),                              // open (upside)
    opp({ classification: 'closed_won', amount: 200_000, stage: 'Closed Won' }),    // won
    opp({ classification: 'lost', amount: 40_000, stage: 'Closed Lost' }),          // lost by classification
    opp({ classification: 'unclassified', amount: 25_000, stage: 'Closed Lost' }),  // lost by stage only
    opp({ classification: 'omitted', amount: 999_000 }),                            // excluded from both
    opp({ classification: 'rejected', amount: 888_000 }),                           // excluded from both
  ];

  const { totalPipe, closedLost, startingPipe } = computeHudPipe(scoped);

  it('sums Total Pipe as open + commit + upside + closed won (excludes lost/omitted/rejected)', () => {
    expect(totalPipe).toBe(100_000 + 50_000 + 30_000 + 200_000); // 380,000
  });

  it('sums Closed Lost from both classification and stage, excluding omitted/rejected', () => {
    expect(closedLost).toBe(40_000 + 25_000); // 65,000
  });

  it('Starting Pipe is the full open + won + lost universe with no double-count', () => {
    expect(startingPipe).toBe(380_000 + 65_000); // 445,000
    // omitted/rejected (999k + 888k) never enter the picture
    expect(startingPipe).toBeLessThan(999_000);
  });

  it('reconciliation holds exactly: Starting Pipe − Closed Lost === Total Pipe', () => {
    expect(startingPipe - closedLost).toBe(totalPipe);
  });

  it('reconciliation holds for arbitrary scoped sets (property check)', () => {
    const cases: Opportunity[][] = [
      [],
      [opp({ classification: 'closed_won', amount: 920_889, stage: 'Closed Won' })],
      [opp({ classification: 'lost', amount: 12_345, stage: 'Closed Lost' })],
      [
        opp({ classification: 'commit', amount: 1 }),
        opp({ classification: 'lost', amount: 2, stage: 'Closed Lost' }),
        opp({ classification: 'omitted', amount: 3 }),
      ],
    ];
    for (const set of cases) {
      const r = computeHudPipe(set);
      expect(r.startingPipe - r.closedLost).toBe(r.totalPipe);
    }
  });

  it('an empty scope reconciles to zero across the board', () => {
    const r = computeHudPipe([]);
    expect(r).toEqual({ totalPipe: 0, closedLost: 0, startingPipe: 0 });
  });
});
