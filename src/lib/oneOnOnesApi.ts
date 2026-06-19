import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import type { ActionItem, OneOnOne } from './oneOnOnes';

export async function loadOneOnOne(repId: string, week: string): Promise<OneOnOne | null> {
  const { data, error } = await supabase
    .from('one_on_ones')
    .select('rep_id, week, notes, action_items')
    .eq('rep_id', repId)
    .eq('week', week)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    repId: data.rep_id,
    week: data.week,
    notes: data.notes ?? '',
    actionItems: Array.isArray(data.action_items) ? (data.action_items as unknown as ActionItem[]) : [],
  };
}

export async function saveOneOnOne(o: OneOnOne): Promise<void> {
  // Include user_id to satisfy the RLS with-check, then upsert on the composite key
  // (same shape as the app_state upsert in ForecastContext).
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('Not signed in');
  const { error } = await supabase.from('one_on_ones').upsert({
    user_id: userId,
    rep_id: o.repId,
    week: o.week,
    notes: o.notes,
    action_items: o.actionItems as unknown as Json,
  }, { onConflict: 'user_id,rep_id,week' });
  if (error) throw new Error(error.message);
}
