import { describe, it, expect } from 'vitest';
import {
  compactSnapshots,
  compactChangelog,
  stripDrBatches,
  stripImports,
  compactForecastState,
  snapshotReductionByOpp,
  HISTORY_PER_OPP_LIMIT,
} from '@/lib/storageCompaction';
import type { OpportunitySnapshot, ChangeLogEntry, DrBatch, ImportRecord } from '@/types/forecast';

function snap(over: Partial<OpportunitySnapshot> & { opportunityId: string; importDate: string }): OpportunitySnapshot {
  return {
    fileName: 'f.xlsx', amount: 1000, closeDate: '2026-03-01', stage: 'Discovery',
    classification: 'commit', name: 'Opp', repName: 'Rep One', ...over,
  };
}

function change(over: Partial<ChangeLogEntry> & { opportunityId: string; importDate: string; field: ChangeLogEntry['field'] }): ChangeLogEntry {
  return {
    id: `${over.opportunityId}-${over.field}-${over.importDate}`,
    fileName: 'f.xlsx', opportunityName: 'Opp', repName: 'Rep One',
    oldValue: 'a', newValue: 'b', ...over,
  };
}

describe('compactSnapshots', () => {
  it('collapses consecutive identical snapshots for an opportunity', () => {
    const snaps = [
      snap({ opportunityId: 'A', importDate: '2026-01-01' }),
      snap({ opportunityId: 'A', importDate: '2026-01-08' }), // identical → dropped
      snap({ opportunityId: 'A', importDate: '2026-01-15', amount: 2000 }), // changed → kept
      snap({ opportunityId: 'A', importDate: '2026-01-22', amount: 2000 }), // identical → dropped
    ];
    const out = compactSnapshots(snaps);
    expect(out).toHaveLength(2);
    expect(out.map(s => s.amount)).toEqual([1000, 2000]);
  });

  it('keeps at most the most-recent perOpp snapshots per opportunity', () => {
    const snaps: OpportunitySnapshot[] = [];
    for (let i = 0; i < 100; i++) {
      // distinct amount → distinct signature, so none are deduped; valid ISO times
      const hh = String(Math.floor(i / 60)).padStart(2, '0');
      const mm = String(i % 60).padStart(2, '0');
      snaps.push(snap({ opportunityId: 'A', importDate: `2026-01-01T${hh}:${mm}:00Z`, amount: i }));
    }
    const out = compactSnapshots(snaps, 60);
    expect(out).toHaveLength(60);
    // kept the most-recent 60 (amounts 40..99)
    expect(Math.min(...out.map(s => s.amount))).toBe(40);
  });

  it('does not mix history across opportunities', () => {
    const snaps = [
      snap({ opportunityId: 'A', importDate: '2026-01-01', amount: 1 }),
      snap({ opportunityId: 'B', importDate: '2026-01-01', amount: 1 }),
    ];
    const out = compactSnapshots(snaps);
    expect(out).toHaveLength(2); // same signature but different opps — both kept
  });

  it('collapses rename-only snapshots (name is NOT part of the signature)', () => {
    // The confirmed case: 006Vy00001CHe1d renamed 4x on 2026-02-05 with no change to
    // amount / closeDate / stage. All four collapse to one.
    const id = '006Vy00001CHe1d';
    const snaps = [
      snap({ opportunityId: id, importDate: '2026-02-05T10:12:00Z', name: 'Cove Backup' }),
      snap({ opportunityId: id, importDate: '2026-02-05T10:18:00Z', name: 'Cove Backup (SHI)' }),
      snap({ opportunityId: id, importDate: '2026-02-05T10:24:00Z', name: 'Filtration Group / Cove' }),
      snap({ opportunityId: id, importDate: '2026-02-05T10:28:00Z', name: 'Filtration Group / SHI / Cove Backup' }),
    ];
    const out = compactSnapshots(snaps);
    expect(out).toHaveLength(1);
    // the surviving snapshot still carries a name for display
    expect(out[0].name).toBeTruthy();
  });

  it('still keeps a snapshot when amount / closeDate / stage / owner genuinely change', () => {
    const id = 'A';
    const snaps = [
      snap({ opportunityId: id, importDate: '2026-01-01T00:00:00Z' }),
      snap({ opportunityId: id, importDate: '2026-01-02T00:00:00Z', name: 'renamed', amount: 5000 }), // amount change → kept
      snap({ opportunityId: id, importDate: '2026-01-03T00:00:00Z', name: 'renamed again', stage: 'Technical' }), // stage change → kept
      snap({ opportunityId: id, importDate: '2026-01-04T00:00:00Z', repName: 'New Owner' }), // owner transfer → kept
    ];
    const out = compactSnapshots(snaps);
    expect(out).toHaveLength(4);
  });
});

describe('snapshotReductionByOpp', () => {
  it('reports per-opp reductions sorted by largest, with total before/after', () => {
    const before = [
      snap({ opportunityId: 'X', importDate: '2026-02-05T10:12:00Z', name: 'n1' }),
      snap({ opportunityId: 'X', importDate: '2026-02-05T10:18:00Z', name: 'n2' }),
      snap({ opportunityId: 'X', importDate: '2026-02-05T10:24:00Z', name: 'n3' }),
      snap({ opportunityId: 'Y', importDate: '2026-01-01T00:00:00Z', name: 'y' }),
    ];
    const after = compactSnapshots(before);
    const red = snapshotReductionByOpp(before, after);
    expect(red.totalBefore).toBe(4);
    expect(red.totalAfter).toBe(2); // X collapses 3→1, Y stays 1
    expect(red.byOpp[0]).toMatchObject({ opportunityId: 'X', before: 3, after: 1, removed: 2, name: 'n3' });
    expect(red.byOpp.find(r => r.opportunityId === 'Y')).toBeUndefined(); // no reduction → omitted
  });
});

describe('compactChangelog', () => {
  it('retains every closeDate and classification entry regardless of volume', () => {
    const log: ChangeLogEntry[] = [];
    for (let i = 0; i < 100; i++) {
      log.push(change({ opportunityId: 'A', importDate: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`, field: 'closeDate' }));
      log.push(change({ opportunityId: 'A', importDate: `2026-01-01T01:${String(i).padStart(2, '0')}:00Z`, field: 'classification' }));
    }
    const out = compactChangelog(log, 10);
    // All 200 metric-critical entries survive even though perOpp is only 10.
    expect(out).toHaveLength(200);
  });

  it('caps audit-only fields at the most recent perOpp per opportunity', () => {
    const log: ChangeLogEntry[] = [];
    for (let i = 0; i < 100; i++) {
      log.push(change({ opportunityId: 'A', importDate: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`, field: 'amount', newValue: String(i) }));
    }
    const out = compactChangelog(log, 60);
    expect(out).toHaveLength(60);
    // kept the most-recent ones (i = 40..99)
    expect(out.map(e => Number(e.newValue)).sort((a, b) => a - b)[0]).toBe(40);
  });

  it('preserves metric entries while trimming audit churn on the same opportunity', () => {
    const log: ChangeLogEntry[] = [
      change({ opportunityId: 'A', importDate: '2026-01-01T00:00:00Z', field: 'classification' }),
      ...Array.from({ length: 80 }, (_, i) =>
        change({ opportunityId: 'A', importDate: `2026-02-01T00:${String(i).padStart(2, '0')}:00Z`, field: 'stage' })),
    ];
    const out = compactChangelog(log, 60);
    expect(out.filter(e => e.field === 'classification')).toHaveLength(1);
    expect(out.filter(e => e.field === 'stage')).toHaveLength(60);
  });
});

describe('stripDrBatches / stripImports', () => {
  it('drops stray raw-row payload fields from batches, keeping metadata', () => {
    const dirty = [{
      id: 'b1', importedAt: '2026-06-01T00:00:00Z', fileName: 'dr.xlsx', recordCount: 3,
      newCount: 1, updatedCount: 1, rejectedCount: 0, convertedCount: 1, asOfDate: '2026-06-01',
      // legacy heavy payload from an older app version:
      rawRecords: Array.from({ length: 1000 }, (_, i) => ({ opportunityId: `x${i}`, blob: 'y'.repeat(200) })),
    }] as unknown as DrBatch[];
    const out = stripDrBatches(dirty);
    expect(out[0]).not.toHaveProperty('rawRecords');
    expect(out[0].recordCount).toBe(3);
    expect(out[0].asOfDate).toBe('2026-06-01');
  });

  it('reduces imports to metadata columns', () => {
    const dirty = [{
      id: 'i1', date: '2026-06-01', fileName: 'f.xlsx', opportunityCount: 10,
      rows: Array.from({ length: 500 }, () => ({ a: 'b' })),
    }] as unknown as ImportRecord[];
    const out = stripImports(dirty);
    expect(out[0]).not.toHaveProperty('rows');
    expect(out[0].opportunityCount).toBe(10);
  });
});

describe('compactForecastState', () => {
  it('reports a real size reduction when legacy payloads and duplicate history exist', () => {
    const drBatches = [{
      id: 'b1', importedAt: '2026-06-01T00:00:00Z', fileName: 'dr.xlsx', recordCount: 1,
      newCount: 1, updatedCount: 0, rejectedCount: 0, convertedCount: 0, asOfDate: '2026-06-01',
      rawRecords: Array.from({ length: 2000 }, (_, i) => ({ opportunityId: `x${i}`, blob: 'z'.repeat(200) })),
    }] as unknown as DrBatch[];
    const snapshots = Array.from({ length: 50 }, (_, i) =>
      snap({ opportunityId: 'A', importDate: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z` })); // all identical → collapse to 1

    const result = compactForecastState({ snapshots, changelog: [], drBatches, imports: [] });
    expect(result.report.afterKB).toBeLessThan(result.report.beforeKB);
    expect(result.report.changed).toBe(true);
    expect(result.report.removedSnapshots).toBe(49);
    expect(result.drBatches[0]).not.toHaveProperty('rawRecords');
  });

  it('is a no-op (changed=false) on already-clean data', () => {
    const snapshots = [snap({ opportunityId: 'A', importDate: '2026-01-01' })];
    const result = compactForecastState({ snapshots, changelog: [], drBatches: [], imports: [] });
    expect(result.report.changed).toBe(false);
    expect(result.report.removedSnapshots).toBe(0);
  });

  it('exposes a sane default per-opp history limit', () => {
    expect(HISTORY_PER_OPP_LIMIT).toBe(60);
  });
});
