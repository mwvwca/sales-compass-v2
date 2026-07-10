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

  it('with a transcript (C1 pass) produces the reviewed wording', () => {
    const note = inspectionNote(inspectOpportunity(opp({}), true, TODAY), 'MB', TODAY);
    expect(note).toContain('N-gage criteria met');
    expect(note).toContain('discovery call reviewed via transcript');
  });

  it('without a transcript (C1 manual) produces the pending wording and never claims a review', () => {
    const note = inspectionNote(inspectOpportunity(opp({}), false, TODAY), 'MB', TODAY);
    expect(note).toContain('C2/C3 validated');
    expect(note).toContain('discovery call review pending, no transcript on file');
    expect(note).toContain('ACV validated at $42,500');
    // Must NOT claim a review that did not happen.
    expect(note).not.toContain('discovery call reviewed');
    expect(note).not.toContain('criteria met');
  });

  it('a leapfrog note acknowledges the skipped Qualified 5% stage, honoring C1 branching', () => {
    const reviewed = inspectionNote(inspectOpportunity(opp({}), true, TODAY, { leapfrog: true }), 'MB', TODAY);
    expect(reviewed).toContain('stage progression skipped Qualified 5%; retroactive inspection performed');
    expect(reviewed).toContain('N-gage criteria met');

    const pending = inspectionNote(inspectOpportunity(opp({}), false, TODAY, { leapfrog: true }), 'MB', TODAY);
    expect(pending).toContain('stage progression skipped Qualified 5%; retroactive inspection performed');
    expect(pending).toContain('discovery call review pending, no transcript on file');
    expect(pending).not.toContain('criteria met');
    expect(pending).not.toContain('discovery call reviewed');
  });

  it('a failing leapfrog deal still produces the returned-to-rep variant, prefixed with the skip note', () => {
    const note = inspectionNote(inspectOpportunity(opp({ amount: 0 }), false, TODAY, { leapfrog: true }), 'MB', TODAY);
    expect(note).toContain('stage progression skipped Qualified 5%; retroactive inspection performed');
    expect(note).toContain('Inspection incomplete');
    expect(note).not.toContain('criteria met');
  });
});
