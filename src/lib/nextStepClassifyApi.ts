import { callBriefingApi } from './briefingApi';
import {
  NEXT_STEP_SYSTEM_PROMPT, buildClassifyUserMessage, parseClassifyResponse,
  type ClassifyItem, type NextStepClassification,
} from './nextStepClassify';

// Reuses the generic `briefing` edge function (systemPrompt + userMessage → text),
// so there's no new function to deploy. Haiku keeps classification cheap; batching
// keeps the round-trips down.
const MODEL = 'claude-haiku-4-5-20251001';
const BATCH_SIZE = 40;

/** Classify a set of next-step texts → { oppId: { quality, isDated } }. */
export async function classifyNextSteps(items: ClassifyItem[]): Promise<Record<string, NextStepClassification>> {
  const out: Record<string, NextStepClassification> = {};
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const ids = new Set(batch.map(b => b.oppId));
    const text = await callBriefingApi(NEXT_STEP_SYSTEM_PROMPT, buildClassifyUserMessage(batch), {
      model: MODEL,
      maxTokens: 1500,
    });
    Object.assign(out, parseClassifyResponse(text, ids));
  }
  return out;
}
