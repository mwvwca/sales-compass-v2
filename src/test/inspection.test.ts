import { describe, it, expect } from 'vitest';
import {
  inspectOpportunity, currentDiscoveryDeals, discoveryTransitions, inspectionNote,
} from '@/lib/inspection';
import type { ChangeLogEntry, Opportunity } from '@/types/forecast';

const TODAY = new Date('2026-07-08T12:00:00.000Z');

const opp = (over: Partial<Opportunity>): Opportunity => ({
  id: 'o1',
  salesforceId: '006Vy0000AAAABBBCC',
  name: 'Deal REG - Acme - MDR',
  repId: '',
  repName: 'Wayne Bowe-McLeod',
  amount: 42500,
  closeDate: '2026-08-14',
  stage: 'Discovery 25%',
  classification: 'upside',
  probability: 0.25,
  importDate: '2026-06-01T00:00:00.000Z',
  nextStep: '7/15 technical scoping call with IT director',
  ...over,
} as Opportunity);

describe('criteria checks', () => {
  it('passes a clean deal, with C1 manual when no transcript', () => {
    const r = inspectOpportunity(opp({}), false, TODAY);
    expect(r.overall).toBe('manual');
    expect(r.checks.find(c => c.criterion === 'C2')?.level).toBe('pass');
  });

  it('transcript satisfies C1', () => {
    const r = inspectOpportunity(opp({}), true, TODAY);
    expect(r.overall).toBe('pass');
  });

  it('fails zero amount, empty next step, past close date', () => {
    const r = inspectOpportunity(opp({ amount: 0, nextStep: '', closeDate: '2026-06-01' }), true, TODAY);
    expect(r.overall).toBe('fail');
    expect(r.checks.filter(c => c.level === 'fail').length).toBe(3);
  });

  it('warns on generic next step and quarter-end default date', () => {
    const r = inspectOpportunity(opp({ nextStep: 'follow up', closeDate: '2026-09-30' }), true, TODAY);
    expect(r.overall).toBe('warn');
  });

  it('warns on small round-number amounts', () => {
    const r = inspectOpportunity(opp({ amount: 10000 }), true, TODAY);
    expect(r.checks.find(c => c.detail.includes('round default'))?.level).toBe('warn');
  });
});

describe('discovery population and transitions', () => {
  it('selects only open Discovery-stage deals', () => {
    const deals = currentDiscoveryDeals([
      opp({}),
      opp({ id: 'x', stage: 'Technical Validation' }),
      opp({ id: 'y', classification: 'lost' }),
    ]);
    expect(deals.length).toBe(1);
  });

  it('detects qualified-to-discovery and flags leapfrogs, resolving UUID-id opps via salesforceId', () => {
    const uuidOpp = opp({ id: '3f9c2a10-1111-4222-8333-abcdefabcdef' });
    const entry = (over: Partial<ChangeLogEntry>): ChangeLogEntry => ({
      id: crypto.randomUUID(), importDate: '2026-07-01T00:00:00.000Z', fileName: 'x.xlsx',
      opportunityId: '006Vy0000AAAABBBCC', opportunityName: uuidOpp.name, repName: uuidOpp.repName,
      field: 'stage', oldValue: 'Qualified 5%', newValue: 'Discovery 25%', ...over,
    });
    const ts = discoveryTransitions(
      [entry({}), entry({ oldValue: 'Unqualified' }), entry({ newValue: 'Technical Validation' }), entry({ importDate: '2026-05-01T00:00:00.000Z' })],
      [uuidOpp],
      '2026-06-19T00:00:00.000Z',
    );
    expect(ts.length).toBe(2);
    expect(ts.filter(t => t.leapfrog).length).toBe(1);
    expect(ts[0].opp?.id).toBe(uuidOpp.id);
  });
});

describe('note generation', () => {
  it('produces the mandated format for a passing deal', () => {
    const note = inspectionNote(inspectOpportunity(opp({}), true, TODAY), 'mb', TODAY);
    expect(note.startsWith('7/8/2026 MB: N-gage criteria met')).toBe(true);
    expect(note).toContain('ACV validated at $42,500');
    expect(note).toContain('close date confirmed 2026-08-14');
  });

  it('produces a returned-to-rep note for failing deals', () => {
    const note = inspectionNote(inspectOpportunity(opp({ amount: 0 }), true, TODAY), 'MB', TODAY);
    expect(note).toContain('Inspection incomplete');
    expect(note).toContain('$0');
  });
});
