import { supabase } from '@/integrations/supabase/client';

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

// ---- Persistence (supabase.from('one_on_ones')) ----

interface OneOnOneRow {
  user_id: string;
  rep_id: string;
  week: string;
  notes: string;
  action_items: ActionItem[];
  updated_at?: string;
}

// one_on_ones isn't in the generated Database type until `supabase gen types` is
// run from a Terminal (post-migration). Hand-type the row and use an untyped handle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const table = () => (supabase as any).from('one_on_ones');

export async function loadOneOnOne(repId: string, week: string): Promise<OneOnOne | null> {
  const { data, error } = await table()
    .select('rep_id, week, notes, action_items')
    .eq('rep_id', repId)
    .eq('week', week)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as OneOnOneRow | null;
  if (!row) return null;
  return {
    repId: row.rep_id,
    week: row.week,
    notes: row.notes ?? '',
    actionItems: Array.isArray(row.action_items) ? row.action_items : [],
  };
}

export async function saveOneOnOne(o: OneOnOne): Promise<void> {
  // Include user_id to satisfy the RLS with-check, then upsert on the composite key
  // (same shape as the app_state upsert in ForecastContext).
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('Not signed in');
  const row: OneOnOneRow = {
    user_id: userId,
    rep_id: o.repId,
    week: o.week,
    notes: o.notes,
    action_items: o.actionItems,
  };
  const { error } = await table().upsert(row, { onConflict: 'user_id,rep_id,week' });
  if (error) throw new Error(error.message);
}
