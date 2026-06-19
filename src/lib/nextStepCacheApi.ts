import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import type { NextStepCache } from './nextStepClassify';

// The classification cache is persisted under a single app_state key (RLS-scoped to
// the user) so repeated 3x/day imports never re-spend on unchanged next-step text.
// It uses its own key, separate from ForecastContext's STORAGE_KEYS, so the two
// don't clobber each other.
const KEY = 'next_step_classifications';

export async function loadNextStepCache(): Promise<NextStepCache> {
  const { data, error } = await supabase
    .from('app_state')
    .select('value')
    .eq('key', KEY)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.value as unknown as NextStepCache) ?? {};
}

export async function saveNextStepCache(cache: NextStepCache): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('Not signed in');
  const { error } = await supabase.from('app_state').upsert(
    { user_id: userId, key: KEY, value: cache as unknown as Json },
    { onConflict: 'user_id,key' },
  );
  if (error) throw new Error(error.message);
}
