// Pure 1:1 logic only — no I/O. Persistence lives in ./oneOnOnesApi so tests can
// import these helpers without pulling in the supabase client.

export interface ActionItem {
  id: string;
  text: string;
  done: boolean;
  owner?: string;
  due?: string;
}

export interface OneOnOne {
  repId: string;
  /** Monday (UTC) of the 1:1 week, as 'YYYY-MM-DD'. */
  week: string;
  notes: string;
  actionItems: ActionItem[];
}

/** Monday (UTC) of the given date's ISO week, formatted 'YYYY-MM-DD'. */
export function weekKey(d: Date): string {
  const day = d.getUTCDay();                 // 0=Sun .. 6=Sat
  const shift = day === 0 ? -6 : 1 - day;    // back to this week's Monday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + shift));
  return monday.toISOString().slice(0, 10);
}

// ---- Pure action-item reducers (used by the UI and unit-tested) ----

/** Append a new action item. id defaults to a fresh UUID; tests pass an explicit id. */
export function addActionItem(items: ActionItem[], text = '', id: string = crypto.randomUUID()): ActionItem[] {
  return [...items, { id, text, done: false }];
}

export function toggleActionItem(items: ActionItem[], id: string): ActionItem[] {
  return items.map(i => (i.id === id ? { ...i, done: !i.done } : i));
}

export function updateActionItem(items: ActionItem[], id: string, patch: Partial<Omit<ActionItem, 'id'>>): ActionItem[] {
  return items.map(i => (i.id === id ? { ...i, ...patch } : i));
}

export function removeActionItem(items: ActionItem[], id: string): ActionItem[] {
  return items.filter(i => i.id !== id);
}
