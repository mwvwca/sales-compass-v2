import { supabase } from '@/integrations/supabase/client';
import type { BriefingMode } from './briefingPrompts';
import { SYSTEM_PROMPTS } from './briefingPrompts';
import { formatBriefingUserMessage, type BriefingPayload } from './briefingDataBuilder';

export async function callBriefingApi(
  systemPrompt: string,
  userMessage: string,
  opts: { model?: string; maxTokens?: number } = {},
): Promise<string> {
  const { data, error } = await supabase.functions.invoke('briefing', {
    body: {
      systemPrompt,
      userMessage,
      model: opts.model || 'claude-sonnet-4-20250514',
      maxTokens: opts.maxTokens ?? 1000,
    },
  });
  if (error) throw new Error(error.message || 'Failed to call briefing service');
  if (!data?.text) throw new Error(data?.error || 'Empty response from briefing service');
  return data.text as string;
}

export async function generateBriefing(payload: BriefingPayload, mode: BriefingMode): Promise<string> {
  return callBriefingApi(SYSTEM_PROMPTS[mode], formatBriefingUserMessage(payload));
}
