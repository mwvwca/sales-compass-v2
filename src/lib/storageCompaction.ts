import type {
  OpportunitySnapshot,
  ChangeLogEntry,
  DrBatch,
  ImportRecord,
} from '@/types/forecast';

/**
 * localStorage compaction.
 *
 * The app mirrors all forecast state into localStorage (with Supabase as the
 * source of truth). Over many weekly imports that store grows without bound and
 * can breach the ~5MB browser ceiling. This module removes only redundant,
 * safe-to-drop payloads — never DealRegistration/opportunity records, DR stage
 * history, or any entry that feeds a visible metric:
 *
 *  1. Batch/import records are reduced to their known metadata columns. Current
 *     schemas already store only metadata, but older app versions could have
 *     persisted raw uploaded rows alongside them; a whitelist reclaims that space
 *     and is a no-op on clean data.
 *  2. Per-opportunity snapshot history is de-duplicated (consecutive identical
 *     snapshots carry no information) and capped at the most recent N entries.
 *  3. The changelog — the one genuinely unbounded history — is capped per
 *     opportunity, but EVERY closeDate and classification entry is retained
 *     because SlipReport and commit-accuracy read that history across quarters.
 *     Only the higher-volume audit fields (amount/stage/name/repName/nextStep)
 *     are bounded to the most recent N per opportunity.
 */

export const HISTORY_PER_OPP_LIMIT = 60;

const DR_BATCH_KEYS: (keyof DrBatch)[] = [
  'id', 'importedAt', 'fileName', 'recordCount',
  'newCount', 'updatedCount', 'rejectedCount', 'convertedCount', 'asOfDate',
];

const IMPORT_RECORD_KEYS: (keyof ImportRecord)[] = ['id', 'date', 'fileName', 'opportunityCount'];

/** Changelog fields whose full cross-quarter history feeds visible metrics — never pruned. */
const METRIC_CHANGELOG_FIELDS = new Set<ChangeLogEntry['field']>(['closeDate', 'classification']);

function pick<T, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

/** Approximate localStorage byte cost of a value (UTF-16: 2 bytes/char), in KB. */
export function sizeKB(value: unknown): number {
  return Math.round((JSON.stringify(value ?? null).length * 2) / 1024);
}

/** Strip DR batch records down to metadata, dropping any stray raw-row payload fields. */
export function stripDrBatches(batches: DrBatch[]): DrBatch[] {
  return batches.map(b => pick(b, DR_BATCH_KEYS) as DrBatch);
}

/** Strip opportunity-import records down to metadata. */
export function stripImports(imports: ImportRecord[]): ImportRecord[] {
  return imports.map(r => pick(r, IMPORT_RECORD_KEYS) as ImportRecord);
}

function snapshotSignature(s: OpportunitySnapshot): string {
  return [s.amount, s.closeDate, s.stage, s.classification, s.name, s.repName].join('|');
}

/**
 * De-duplicate and cap per-opportunity snapshot history.
 * - drops a snapshot whose tracked fields are identical to the previously kept one
 *   for that opportunity (a run of unchanged imports collapses to one entry),
 * - keeps at most `perOpp` most-recent snapshots per opportunity.
 * Original array order is preserved for unaffected entries.
 */
export function compactSnapshots(
  snapshots: OpportunitySnapshot[],
  perOpp = HISTORY_PER_OPP_LIMIT,
): OpportunitySnapshot[] {
  const byOpp = new Map<string, OpportunitySnapshot[]>();
  for (const s of snapshots) {
    const arr = byOpp.get(s.opportunityId) || [];
    arr.push(s);
    byOpp.set(s.opportunityId, arr);
  }

  const keep = new Set<OpportunitySnapshot>();
  for (const arr of byOpp.values()) {
    // Chronological, stable — importDate is an ISO string so lexical order works.
    const chrono = [...arr].sort((a, b) => a.importDate.localeCompare(b.importDate));
    const deduped: OpportunitySnapshot[] = [];
    let lastSig: string | null = null;
    for (const s of chrono) {
      const sig = snapshotSignature(s);
      if (sig === lastSig) continue; // redundant consecutive duplicate
      deduped.push(s);
      lastSig = sig;
    }
    for (const s of deduped.slice(-perOpp)) keep.add(s);
  }

  return snapshots.filter(s => keep.has(s));
}

/**
 * Cap per-opportunity changelog history while preserving every metric-critical
 * entry. All closeDate/classification entries are kept (SlipReport & commit
 * accuracy depend on them across quarters); the remaining audit-only fields are
 * capped at the most recent `perOpp` entries per opportunity.
 */
export function compactChangelog(
  changelog: ChangeLogEntry[],
  perOpp = HISTORY_PER_OPP_LIMIT,
): ChangeLogEntry[] {
  const prunableByOpp = new Map<string, ChangeLogEntry[]>();
  for (const e of changelog) {
    if (METRIC_CHANGELOG_FIELDS.has(e.field)) continue;
    const arr = prunableByOpp.get(e.opportunityId) || [];
    arr.push(e);
    prunableByOpp.set(e.opportunityId, arr);
  }

  const keptPrunable = new Set<ChangeLogEntry>();
  for (const arr of prunableByOpp.values()) {
    const chrono = [...arr].sort((a, b) => a.importDate.localeCompare(b.importDate));
    for (const e of chrono.slice(-perOpp)) keptPrunable.add(e);
  }

  return changelog.filter(e => METRIC_CHANGELOG_FIELDS.has(e.field) || keptPrunable.has(e));
}

export interface CompactionReport {
  beforeKB: number;
  afterKB: number;
  changed: boolean;
  removedSnapshots: number;
  removedChangelog: number;
}

/** Slices this compaction touches; other persisted slices pass through untouched. */
export interface CompactableSlices {
  snapshots: OpportunitySnapshot[];
  changelog: ChangeLogEntry[];
  drBatches: DrBatch[];
  imports: ImportRecord[];
}

export interface CompactionResult extends CompactableSlices {
  report: CompactionReport;
}

/**
 * Compact the four space-prone slices and report before/after size. `otherSlices`
 * are every remaining persisted slice (opportunities, dealRegistrations, etc.) —
 * included only so the reported KB reflects the whole localStorage footprint, not
 * just the compacted keys. They are never modified.
 */
export function compactForecastState(
  slices: CompactableSlices,
  otherSlices: Record<string, unknown> = {},
): CompactionResult {
  const snapshots = compactSnapshots(slices.snapshots);
  const changelog = compactChangelog(slices.changelog);
  const drBatches = stripDrBatches(slices.drBatches);
  const imports = stripImports(slices.imports);

  const otherKB = sizeKB(Object.values(otherSlices));
  const beforeKB = otherKB + sizeKB(slices.snapshots) + sizeKB(slices.changelog) + sizeKB(slices.drBatches) + sizeKB(slices.imports);
  const afterKB = otherKB + sizeKB(snapshots) + sizeKB(changelog) + sizeKB(drBatches) + sizeKB(imports);

  const removedSnapshots = slices.snapshots.length - snapshots.length;
  const removedChangelog = slices.changelog.length - changelog.length;
  const changed =
    removedSnapshots > 0 ||
    removedChangelog > 0 ||
    JSON.stringify(slices.drBatches) !== JSON.stringify(drBatches) ||
    JSON.stringify(slices.imports) !== JSON.stringify(imports);

  return {
    snapshots,
    changelog,
    drBatches,
    imports,
    report: { beforeKB, afterKB, changed, removedSnapshots, removedChangelog },
  };
}
