import { supabase } from '@/integrations/supabase/client';
import type { BriefingMode } from './briefingPrompts';
import { SYSTEM_PROMPTS } from './briefingPrompts';
import { formatBriefingUserMessage, type BriefingPayload } from './briefingDataBuilder';

export async function generateBriefing(payload: BriefingPayload, mode: BriefingMode): Promise<string> {
  const { data, error } = await supabase.functions.invoke('briefing', {
    body: {
      systemPrompt: SYSTEM_PROMPTS[mode],
      userMessage: formatBriefingUserMessage(payload),
      model: 'claude-sonnet-4-20250514',
      maxTokens: 1000,
    },
  });

  if (error) {
    throw new Error(error.message || 'Failed to generate briefing');
  }
  if (!data?.text) {
    throw new Error(data?.error || 'Empty response from briefing service');
  }
  return data.text as string;
}
