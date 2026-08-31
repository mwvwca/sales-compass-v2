import { describe, it, expect } from 'vitest';
import { NO_NEW_OWNER_NOTICE, type NewOwnerNotice } from '@/context/ForecastContext';

/**
 * Regression guard for the production sync outage.
 *
 * `app_state.value` is NOT NULL, and PostgREST maps a JavaScript `null` to SQL NULL.
 * Every changed slice goes up in ONE batch upsert, so a single null-valued row 400s
 * the entire request — taking every other slice's sync down with it, not just its own.
 * On top of that the dirty-tracker used to mark keys saved before the upsert resolved,
 * so a failed sync never retried and the failure was permanent.
 *
 * The rule this locks in: no persisted slice may ever be null or undefined.
 */

/** Mirrors the row-building step of the cloud write-through in ForecastContext. */
function buildRows(state: Record<string, unknown>, keys: Record<string, string>) {
  const rows: { key: string; value: unknown }[] = [];
  const skipped: string[] = [];
  for (const [field, storageKey] of Object.entries(keys)) {
    const value = state[field];
    if (value === null || value === undefined) {
      skipped.push(storageKey);
      continue;
    }
    rows.push({ key: storageKey, value });
  }
  return { rows, skipped };
}

describe('app_state cloud sync — NOT NULL safety', () => {
  it('never sends a null value, and drops only the offending key', () => {
    const { rows, skipped } = buildRows(
      { reps: [], opportunities: [{ id: 'a' }], newOwnerNotice: null },
      { reps: 'forecast_reps', opportunities: 'forecast_opportunities', newOwnerNotice: 'forecast_new_owner_notice' },
    );
    expect(rows.every(r => r.value !== null && r.value !== undefined)).toBe(true);
    expect(skipped).toEqual(['forecast_new_owner_notice']);
    // The whole point: the other slices still sync.
    expect(rows.map(r => r.key)).toEqual(['forecast_reps', 'forecast_opportunities']);
  });

  it('skips undefined too', () => {
    const { skipped } = buildRows({ a: undefined }, { a: 'forecast_a' });
    expect(skipped).toEqual(['forecast_a']);
  });

  it('passes through empty arrays and objects — those are valid, non-null values', () => {
    const { rows, skipped } = buildRows(
      { reps: [], migrations: {} },
      { reps: 'forecast_reps', migrations: 'forecast_migrations' },
    );
    expect(skipped).toEqual([]);
    expect(rows).toHaveLength(2);
  });
});

describe('NO_NEW_OWNER_NOTICE', () => {
  it('is a non-null value that reads as "no pending notice"', () => {
    const notice: NewOwnerNotice = NO_NEW_OWNER_NOTICE;
    expect(notice).not.toBeNull();
    expect(notice.names).toEqual([]);
    // This is the condition the banner renders on.
    expect(notice.names.length === 0).toBe(true);
  });

  it('survives the row builder instead of being skipped', () => {
    const { rows, skipped } = buildRows(
      { newOwnerNotice: NO_NEW_OWNER_NOTICE },
      { newOwnerNotice: 'forecast_new_owner_notice' },
    );
    expect(skipped).toEqual([]);
    expect(rows[0].value).toEqual({ names: [], detectedAt: '' });
  });
});

describe('dirty-tracker retry semantics', () => {
  // The second half of the outage: keys were marked saved before the upsert resolved,
  // so a failure looked clean and never re-sent. Marking must happen on success only.
  function syncOnce(lastSaved: Record<string, string>, key: string, json: string, ok: boolean) {
    if (lastSaved[key] === json) return { sent: false, lastSaved };
    if (ok) lastSaved[key] = json;
    return { sent: true, lastSaved };
  }

  it('re-sends a key after a failed sync', () => {
    const tracker: Record<string, string> = {};
    expect(syncOnce(tracker, 'k', '[1]', false).sent).toBe(true);
    expect(syncOnce(tracker, 'k', '[1]', false).sent).toBe(true); // still dirty → retried
    expect(syncOnce(tracker, 'k', '[1]', true).sent).toBe(true);
    expect(syncOnce(tracker, 'k', '[1]', true).sent).toBe(false); // clean → not re-sent
  });
});
