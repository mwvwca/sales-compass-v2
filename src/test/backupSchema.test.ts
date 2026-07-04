import { describe, it, expect } from 'vitest';
import { backupSchema } from '@/lib/backupSchema';

const minimalBackup = {
  reps: [{ id: 'r1', name: 'Sarah Winters', quarterlyGoals: { '2026-Q3': 200000 } }],
  opportunities: [{
    id: '3f9c2a10-1111-4222-8333-abcdefabcdef',
    salesforceId: '006Vy0000AAAABBBCC',
    name: 'Deal',
    repId: '',
    repName: 'Sarah Winters',
    amount: 10000,
    closeDate: '2026-08-15',
    stage: 'Discovery',
    classification: 'upside',
    probability: 0.25,
    importDate: '2026-05-01T00:00:00.000Z',
    resolvedReseller: 'Acme Partners',
  }],
  imports: [],
  // Pre-fix regressions: the field enum rejected nextStep entries (making any
  // real backup unrestorable) and salesforceId/snapshots were silently stripped.
  changelog: [{
    id: 'c1', importDate: '2026-06-30T00:00:00.000Z', fileName: 'x.xlsx',
    opportunityId: '006Vy0000AAAABBBCC', opportunityName: 'Deal', repName: 'Sarah Winters',
    field: 'nextStep', oldValue: '(empty)', newValue: 'Follow up with CTO',
  }],
  snapshots: [{
    opportunityId: '006Vy0000AAAABBBCC', importDate: '2026-06-30T00:00:00.000Z', fileName: 'x.xlsx',
    amount: 10000, closeDate: '2026-08-15', stage: 'Discovery', classification: 'upside',
    name: 'Deal', repName: 'Sarah Winters',
  }],
};

describe('F8: backup schema round-trips real-world payloads', () => {
  it('accepts nextStep changelog entries', () => {
    const r = backupSchema.safeParse(minimalBackup);
    expect(r.success).toBe(true);
  });

  it('preserves salesforceId and unknown opportunity fields instead of stripping them', () => {
    const r = backupSchema.safeParse(minimalBackup);
    expect(r.success).toBe(true);
    if (!r.success) return;
    const opp = r.data.opportunities[0] as Record<string, unknown>;
    expect(opp.salesforceId).toBe('006Vy0000AAAABBBCC');
    expect(opp.resolvedReseller).toBe('Acme Partners');
  });

  it('includes snapshots in the parsed output', () => {
    const r = backupSchema.safeParse(minimalBackup);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.snapshots?.length).toBe(1);
  });
});
