import { describe, it, expect } from 'vitest';
import { buildRepScorecard, type ScorecardContext } from '@/lib/repScorecard';
import type {
  Opportunity, ChangeLogEntry, ManagerQuota, Rep, DealRegistration, Quarter,
} from '@/types/forecast';

const TODAY = new Date('2026-06-18T00:00:00Z');
const OPTS = { today: TODAY, currentQuarter: '2026-Q2' as Quarter };

const REP: Rep = { id: 'r1', name: 'Jane Doe', quarterlyGoals: { '2026-Q2': 500_000 }, isActive: true } as Rep;

function opp(over: Partial<Opportunity> & { id: string }): Opportunity {
  return {
    name: `Deal ${over.id}`, repId: '', repName: 'Jane Doe', amount: 0,
    closeDate: '2026-06-30', stage: 'Discovery', classification: 'unclassified',
    probability: 0.5, importDate: '2026-06-10', nextStep: 'Follow up',
    ...over,
  } as Opportunity;
}
function cl(over: Partial<ChangeLogEntry> & { opportunityId: string }): ChangeLogEntry {
  return {
    id: `cl-${Math.round(over.opportunityId.length)}`, importDate: '2026-06-10', fileName: 'f',
    opportunityName: 'Deal', repName: 'Jane Doe', field: 'classification', oldValue: '', newValue: '',
    ...over,
  } as ChangeLogEntry;
}
function dr(over: Partial<DealRegistration> & { opportunityId: string }): DealRegistration {
  return {
    repName: 'Jane Doe', accountName: 'Acme', status: 'active', isSql: false, probability: 0,
    stage: 'Discovery', stageHistory: [], createdDate: '2026-01-01', ageDays: 10,
    ...over,
  } as DealRegistration;
}
const mq: ManagerQuota = { id: 'q', annualAmount: 1_000_000, year: 2026, createdAt: '', updatedAt: '' } as ManagerQuota;

function ctx(over: Partial<ScorecardContext>): ScorecardContext {
  return { opportunities: [], changelog: [], dealRegistrations: [], managerQuotas: [mq], reps: [REP], ...over };
}

describe('buildRepScorecard', () => {
  it('computes attainment, forecast and pipeline basics', () => {
    const sc = buildRepScorecard('r1', ctx({
      opportunities: [
        opp({ id: 'A', classification: 'closed_won', amount: 200_000 }),
        opp({ id: 'B', classification: 'commit', amount: 150_000, probability: 0.6 }),
        opp({ id: 'C', classification: 'upside', amount: 100_000, probability: 0.5 }),
      ],
    }), OPTS);

    // per-rep quota (quarterlyGoals['2026-Q2']); closed-won + open are all in-quarter here
    expect(sc.attainment).toEqual({ quota: 500_000, closedWon: 200_000, gap: 300_000, coverage: 250_000 / 300_000 });
    expect(sc.forecast.commit).toBe(150_000);
    expect(sc.forecast.bestCase).toBe(250_000);       // commit + upside
    expect(sc.forecast.commitAccuracy).toBeNull();     // nothing resolved
    expect(sc.pipeline.openCount).toBe(2);             // B, C (A is closed)
    expect(sc.pipeline.openAmount).toBe(250_000);
    expect(sc.pipeline.stale).toBe(0);
  });

  it('flags at-risk deals (pushed / stalled / under_qualified) and leaves nextStep + future flags empty', () => {
    const sc = buildRepScorecard('r1', ctx({
      opportunities: [
        opp({ id: 'D', amount: 50_000, probability: 0.1 }),                            // under-qualified
        opp({ id: 'E', classification: 'commit', amount: 120_000, probability: 0.6 }), // pushed 3x
        opp({ id: 'F', amount: 30_000, probability: 0.5, importDate: '2026-01-01' }),   // stalled (old)
      ],
      changelog: [
        cl({ opportunityId: 'E', field: 'closeDate', oldValue: '2026-03-31', newValue: '2026-06-30' }),
        cl({ opportunityId: 'E', field: 'closeDate', oldValue: '2026-06-30', newValue: '2026-09-30' }),
        cl({ opportunityId: 'E', field: 'closeDate', oldValue: '2026-09-30', newValue: '2026-12-31' }),
      ],
    }), OPTS);

    const byId = Object.fromEntries(sc.atRisk.map(d => [d.id, d]));
    expect(byId.D.flags.map(f => f.kind)).toContain('under_qualified');
    expect(byId.E.flags.map(f => f.kind)).toContain('pushed');
    expect(byId.F.flags.map(f => f.kind)).toContain('stalled');
    // sorted by amount desc
    expect(sc.atRisk.map(d => d.id)).toEqual(['E', 'D', 'F']);
    // nextStep now carries the real text (these fixtures all have one)
    expect(sc.atRisk.every(d => d.nextStep === 'Follow up')).toBe(true);
    const allKinds = sc.atRisk.flatMap(d => d.flags.map(f => f.kind));
    expect(allKinds).not.toContain('no_next_step');     // fixtures have a next step
    expect(allKinds).not.toContain('single_threaded');  // still a later step — never fabricated
    // rule-based talking point: a commit deal pushed >=3x
    expect(sc.talkingPoints.some(p => p.includes('Deal E') || p.startsWith('Deal E'))).toBe(true);
  });

  it('derives channel metrics from the AE accountability core', () => {
    const sc = buildRepScorecard('r1', ctx({
      dealRegistrations: [
        dr({ opportunityId: '006a', isSql: true, sqlDate: '2026-02-01', status: 'active' }),
        dr({ opportunityId: '006b', status: 'rejected' }),
        dr({ opportunityId: '006c', status: 'padded' }),
        dr({ opportunityId: '006d', status: 'active' }),
      ],
    }), OPTS);

    expect(sc.channel.rejection).toBeCloseTo(1 / 4);   // 1 rejected of 4 assigned
    expect(sc.channel.padding).toBe(1);                // one padded DR
    expect(sc.channel.sqlRate).toBeCloseTo(1 / 3);     // 1 SQL of 3 non-rejected
  });

  it('computes commit accuracy from resolved (non-current) quarters', () => {
    const sc = buildRepScorecard('r1', ctx({
      opportunities: [
        opp({ id: 'G', classification: 'closed_won', amount: 90_000, closeDate: '2025-12-15', importDate: '2025-11-01' }),
      ],
      changelog: [
        cl({ opportunityId: 'G', field: 'classification', oldValue: 'upside', newValue: 'commit', importDate: '2025-11-01' }),
      ],
    }), OPTS);

    expect(sc.forecast.commitAccuracy).toBe(1); // committed 90k in 2025-Q4, closed 90k
    expect(sc.attainment.closedWon).toBe(0);    // G closed in 2025-Q4 — not the current quarter
  });

  it('coverage and gap clamp: gap floors at 0 when quota already met', () => {
    const sc = buildRepScorecard('r1', ctx({
      opportunities: [
        opp({ id: 'H', classification: 'closed_won', amount: 600_000 }), // exceeds 500k goal, in-quarter
        opp({ id: 'I', classification: 'commit', amount: 90_000, probability: 0.6 }),
      ],
    }), OPTS);
    expect(sc.attainment.closedWon).toBe(600_000);
    expect(sc.attainment.gap).toBe(0);                 // clamped, not negative
    expect(sc.attainment.coverage).toBe(90_000 / 1);   // gap 0 → denominator max(0,1)=1
  });
});
