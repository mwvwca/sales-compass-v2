import { describe, it, expect } from 'vitest';
import {
  weekKey, addActionItem, toggleActionItem, updateActionItem, removeActionItem,
  type ActionItem,
} from '@/lib/oneOnOnes';

describe('weekKey — Monday (UTC) of the week', () => {
  it('returns the same Monday for every day Mon..Sun of that week', () => {
    // 2026-06-15 is a Monday. Mon..Sun all map to 2026-06-15.
    const days = ['2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19', '2026-06-20', '2026-06-21'];
    for (const d of days) {
      expect(weekKey(new Date(`${d}T12:00:00Z`))).toBe('2026-06-15');
    }
  });

  it('Sunday belongs to the week that started the previous Monday', () => {
    // 2026-06-14 is a Sunday → previous Monday 2026-06-08.
    expect(weekKey(new Date('2026-06-14T00:00:00Z'))).toBe('2026-06-08');
  });

  it('handles a Monday exactly at UTC midnight', () => {
    expect(weekKey(new Date('2026-06-15T00:00:00Z'))).toBe('2026-06-15');
  });

  it('crosses a month boundary correctly', () => {
    // 2026-03-01 is a Sunday → previous Monday is 2026-02-23.
    expect(weekKey(new Date('2026-03-01T08:00:00Z'))).toBe('2026-02-23');
  });
});

describe('action-item reducers', () => {
  const base: ActionItem[] = [{ id: 'a', text: 'first', done: false }];

  it('add appends a new, not-done item with the given id', () => {
    const next = addActionItem(base, 'second', 'b');
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({ id: 'b', text: 'second', done: false });
    expect(base).toHaveLength(1); // immutable — original untouched
  });

  it('add without an explicit id mints a non-empty id', () => {
    const next = addActionItem([], 'x');
    expect(next[0].id).toBeTruthy();
    expect(typeof next[0].id).toBe('string');
  });

  it('toggle flips done only for the matching id', () => {
    const items: ActionItem[] = [{ id: 'a', text: 'x', done: false }, { id: 'b', text: 'y', done: true }];
    const next = toggleActionItem(items, 'a');
    expect(next[0].done).toBe(true);
    expect(next[1].done).toBe(true); // unchanged
    expect(items[0].done).toBe(false); // immutable
  });

  it('update patches owner/due/text without touching id', () => {
    const next = updateActionItem(base, 'a', { owner: 'Jane', due: '2026-07-01', text: 'edited' });
    expect(next[0]).toEqual({ id: 'a', text: 'edited', done: false, owner: 'Jane', due: '2026-07-01' });
  });

  it('remove drops the matching id', () => {
    const items: ActionItem[] = [{ id: 'a', text: 'x', done: false }, { id: 'b', text: 'y', done: false }];
    expect(removeActionItem(items, 'a').map(i => i.id)).toEqual(['b']);
  });
});
