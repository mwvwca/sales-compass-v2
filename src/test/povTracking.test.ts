import { describe, it, expect } from 'vitest';
import { detectMotions, motionStats, hasMotionToken } from '@/lib/povTracking';
import type { ChangeLogEntry, Opportunity } from '@/types/forecast';

const NOW = new Date('2026-07-07T00:00:00.000Z');

const opp = (over: Partial<Opportunity>): Opportunity => ({
  id: 'o1',
  salesforceId: '006Vy0000AAAABBBCC',
  name: 'Deal REG - Acme - ePlus - MDR (POV)',
  repId: '',
  repName: 'Sarah Winters',
  amount: 25000,
  closeDate: '2026-08-15',
  stage: 'Technical Validation',
  classification: 'upside',
  probability: 0.5,
  importDate: '2026-03-01T00:00:00.000Z',
  ...over,
} as Opportunity);

const nameChange = (over: Partial<ChangeLogEntry>): ChangeLogEntry => ({
  id: crypto.randomUUID(),
  importDate: '2026-04-21T00:00:00.000Z',
  fileName: 'x.xlsx',
  opportunityId: '006Vy0000AAAABBBCC',
  opportunityName: '',
  repName: 'Sarah Winters',
  field: 'name',
  oldValue: 'Deal REG - Acme - ePlus - MDR',
  newValue: 'Deal REG - Acme - ePlus - MDR (POV)',
  ...over,
});

describe('POV/RFP token detection', () => {
  it('matches word-boundary tokens in all the naming styles seen in real data', () => {
    for (const n of ['MDR POV', '(POV)', 'POV - Deal REG - Town of Danvers', 'MDR - POV', 'EDR (POV)']) {
      expect(hasMotionToken(n, 'POV')).toBe(true);
    }
    expect(hasMotionToken('Provo City Schools - MDR', 'POV')).toBe(false);
    expect(hasMotionToken('Columbia Bank RFP - Reg', 'RFP')).toBe(true);
    expect(hasMotionToken('Columbia Bank RFP - Reg', 'POV')).toBe(false);
  });
});

describe('detectMotions lifecycle', () => {
  it('uses the name-change import date as the exact start', () => {
    const [r] = detectMotions([opp({})], [nameChange({})], 'POV', NOW);
    expect(r.startedAt).toBe('2026-04-21T00:00:00.000Z');
    expect(r.startApproximate).toBe(false);
    expect(r.durationDays).toBe(77);
    expect(r.outcome).toBe('active');
  });

  it('falls back to first-import date, marked approximate, when the token predates tracking', () => {
    const [r] = detectMotions([opp({})], [], 'POV', NOW);
    expect(r.startedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(r.startApproximate).toBe(true);
  });

  it('resolves history recorded under the Salesforce id for UUID-id opportunities', () => {
    const uuid = opp({ id: '3f9c2a10-1111-4222-8333-abcdefabcdef' });
    const [r] = detectMotions([uuid], [nameChange({})], 'POV', NOW);
    expect(r.startApproximate).toBe(false);
    expect(r.startedAt).toBe('2026-04-21T00:00:00.000Z');
  });

  it('uses the earliest add when the token was added, and measures concluded duration to the lost date', () => {
    const lost = opp({ classification: 'lost', lostDate: '2026-06-01T00:00:00.000Z' });
    const later = nameChange({ importDate: '2026-05-05T00:00:00.000Z' });
    const [r] = detectMotions([lost], [later, nameChange({})], 'POV', NOW);
    expect(r.startedAt).toBe('2026-04-21T00:00:00.000Z');
    expect(r.outcome).toBe('lost');
    expect(r.durationDays).toBe(41);
  });

  it('excludes omitted deals and non-matching names', () => {
    const rows = detectMotions([
      opp({ classification: 'omitted' }),
      opp({ id: 'o2', salesforceId: '006Vy0000AAAABBBCD', name: 'Plain deal, no token' }),
    ], [], 'POV', NOW);
    expect(rows.length).toBe(0);
  });
});

describe('motionStats', () => {
  it('computes conversion and median duration over concluded motions only', () => {
    const records = detectMotions([
      opp({}),
      opp({ id: 'w1', salesforceId: '006Vy0000AAAABBB01', classification: 'closed_won', closeDate: '2026-05-01', importDate: '2026-03-02T00:00:00.000Z' }),
      opp({ id: 'l1', salesforceId: '006Vy0000AAAABBB02', classification: 'lost', lostDate: '2026-04-01T00:00:00.000Z', importDate: '2026-03-02T00:00:00.000Z' }),
    ], [], 'POV', NOW);
    const s = motionStats(records, 'POV');
    expect(s.activeCount).toBe(1);
    expect(s.concludedCount).toBe(2);
    expect(s.wonCount).toBe(1);
    expect(s.conversionRate).toBe(0.5);
    // All-approximate starts: duration stat abstains rather than reporting noise
    expect(s.medianDurationDays).toBeNull();
  });
});

describe('manual start overrides', () => {
  it('override wins over observed name changes and counts as reliable duration', () => {
    const withOverride = opp({ motionStartOverrides: { POV: '2026-03-15T00:00:00.000Z' } });
    const [r] = detectMotions([withOverride], [nameChange({})], 'POV', NOW);
    expect(r.startedAt).toBe('2026-03-15T00:00:00.000Z');
    expect(r.startSource).toBe('manual');
    expect(r.startApproximate).toBe(false);
  });

  it('median includes manual starts but still excludes first-import approximations', () => {
    const manualLost = opp({
      id: 'm1', salesforceId: '006Vy0000AAAABBB03', classification: 'lost',
      lostDate: '2026-05-15T00:00:00.000Z',
      motionStartOverrides: { POV: '2026-04-01T00:00:00.000Z' },
    });
    const approxLost = opp({ id: 'a1', salesforceId: '006Vy0000AAAABBB04', classification: 'lost', lostDate: '2026-03-02T00:00:00.000Z' });
    const s = motionStats(detectMotions([manualLost, approxLost], [], 'POV', NOW), 'POV');
    expect(s.medianDurationDays).toBe(44);
  });

  it('is per-kind: a POV override does not affect RFP detection', () => {
    const dual = opp({ name: 'Acme - MDR (POV) RFP', motionStartOverrides: { POV: '2026-03-15T00:00:00.000Z' } });
    const [rfp] = detectMotions([dual], [], 'RFP', NOW);
    expect(rfp.startSource).toBe('first-import');
  });
});
