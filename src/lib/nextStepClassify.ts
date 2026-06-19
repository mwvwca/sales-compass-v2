import type { Opportunity } from '@/types/forecast';

// Pure next-step classification logic — types, hashing, change-detection, cache
// merge, prompt + response parsing. The network call lives in ./nextStepClassifyApi.
// Cost control IS the design: only re-classify when the text changed, open deals
// only, and the cache is hashed by text so repeated imports never re-spend.

export type NextStepQuality = 'concrete' | 'vague';

export interface NextStepClassification {
  quality: NextStepQuality;
  isDated: boolean;
}

/** A cache entry per opp id: the classification plus the text hash it came from. */
export interface CachedNextStep extends NextStepClassification {
  hash: string;
}

export type NextStepCache = Record<string, CachedNextStep>;

const TERMINAL = new Set(['closed_won', 'lost', 'omitted', 'rejected']);

/** Stable, fast non-crypto hash (djb2) of the trimmed next-step text. */
export function hashText(s: string): string {
  let h = 5381;
  const str = (s || '').trim();
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export interface ClassifyItem {
  oppId: string;
  text: string;
}

/**
 * Open deals with a non-empty next step whose text has changed vs the cache —
 * i.e. exactly the deals worth (re)classifying. Closed/empty/unchanged are skipped.
 */
export function selectChangedDeals(opps: Opportunity[], cache: NextStepCache): ClassifyItem[] {
  const out: ClassifyItem[] = [];
  for (const o of opps) {
    if (TERMINAL.has(o.classification)) continue;        // open deals only
    const text = o.nextStep?.trim();
    if (!text) continue;                                  // non-empty only (empty → no_next_step)
    const cached = cache[o.id];
    if (cached && cached.hash === hashText(text)) continue; // unchanged → don't re-spend
    out.push({ oppId: o.id, text });
  }
  return out;
}

/** Merge fresh results into the cache, stamping each with the current text hash. */
export function mergeClassifications(
  cache: NextStepCache,
  items: ClassifyItem[],
  results: Record<string, NextStepClassification>,
): NextStepCache {
  const next: NextStepCache = { ...cache };
  for (const it of items) {
    const r = results[it.oppId];
    if (r) next[it.oppId] = { quality: r.quality, isDated: r.isDated, hash: hashText(it.text) };
  }
  return next;
}

/**
 * Trusted quality for a deal: only return a cached quality when the cache hash
 * still matches the current text (so stale text never shows a wrong flag).
 */
export function qualityFor(opp: Opportunity, cache: NextStepCache): NextStepQuality | undefined {
  const text = opp.nextStep?.trim();
  if (!text) return undefined;
  const cached = cache[opp.id];
  return cached && cached.hash === hashText(text) ? cached.quality : undefined;
}

/**
 * Verdict for a deal's next step: 'none' (empty), 'unclassified' (text present but
 * not classified, or stale), or the cached quality ('concrete' | 'vague').
 */
export function nextStepVerdict(
  id: string,
  nextStep: string | null | undefined,
  cache: NextStepCache,
): 'concrete' | 'vague' | 'unclassified' | 'none' {
  const text = nextStep?.trim();
  if (!text) return 'none';
  const c = cache[id];
  return c && c.hash === hashText(text) ? c.quality : 'unclassified';
}

// ---- prompt + parsing (pure; reused by nextStepClassifyApi via the briefing fn) ----

export const NEXT_STEP_SYSTEM_PROMPT =
`You classify CRM "next step" notes on sales opportunities. For each input, decide:
- "quality": "concrete" if it names a specific action, meeting, owner, or deliverable;
  "vague" if it is generic filler like "follow up", "touch base", "check in", "stay in touch".
- "isDated": true if it references a specific date, day, or timeframe; otherwise false.
Return ONLY a JSON array, one object per input id, no prose and no markdown:
[{"id":"<id>","quality":"concrete","isDated":false}]`;

export function buildClassifyUserMessage(items: ClassifyItem[]): string {
  return JSON.stringify(items.map(i => ({ id: i.oppId, text: i.text })));
}

/** Tolerantly parse the model's JSON array; ignore unknown ids and bad shapes. */
export function parseClassifyResponse(text: string, validIds: Set<string>): Record<string, NextStepClassification> {
  const out: Record<string, NextStepClassification> = {};
  let arr: unknown;
  try {
    const m = text.match(/\[[\s\S]*\]/); // tolerate code fences / surrounding prose
    arr = JSON.parse(m ? m[0] : text);
  } catch {
    return out;
  }
  if (!Array.isArray(arr)) return out;
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    const id = (row as { id?: unknown }).id;
    const quality = (row as { quality?: unknown }).quality;
    if (typeof id !== 'string' || !validIds.has(id)) continue;
    if (quality !== 'concrete' && quality !== 'vague') continue;
    out[id] = { quality, isDated: !!(row as { isDated?: unknown }).isDated };
  }
  return out;
}
