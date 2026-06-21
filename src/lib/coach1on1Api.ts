import { callBriefingApi } from './briefingApi';
import {
  COACH_SYSTEM_PROMPT, buildCoachUserMessage, parseCoachResponse,
  type CoachPayload, type CoachResult,
} from './coach1on1';

// Reuses the generic `briefing` edge function. Sonnet, not Haiku: this is
// low-volume, user-initiated, and quality is the whole point.
export async function coachOneOnOne(payload: CoachPayload): Promise<CoachResult> {
  const text = await callBriefingApi(COACH_SYSTEM_PROMPT, buildCoachUserMessage(payload), {
    model: 'claude-sonnet-4-6',
    maxTokens: 2000,
  });
  return parseCoachResponse(text, new Set(payload.deals.map(d => d.id)));
}
