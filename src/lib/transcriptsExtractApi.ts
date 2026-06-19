import { callBriefingApi } from './briefingApi';
import {
  EXTRACT_SYSTEM_PROMPT, buildExtractUserMessage, parseExtractResponse,
  type TranscriptSignals,
} from './transcripts';

// Reuses the generic `briefing` edge function (no new function to deploy). Sonnet,
// not Haiku — transcript extraction is low-volume and user-initiated, so quality
// matters more than cost here.
export async function extractTranscriptSignals(rawText: string): Promise<TranscriptSignals> {
  const text = await callBriefingApi(EXTRACT_SYSTEM_PROMPT, buildExtractUserMessage(rawText), {
    model: 'claude-sonnet-4-6',
    maxTokens: 1500,
  });
  return parseExtractResponse(text);
}
