import type { TranscriptSignals } from './transcripts';

// "Coach this 1:1": a per-rep deal-inspection pass. The bar is deliberately
// skeptical — activity is not progress — and the rep's imported deal description
// is the primary evidence, with transcript signals as the sharpener. Pure logic
// only (prompt, payload, parse); the network call lives in ./coach1on1Api.

export type CoachVerdict = 'advances' | 'activity' | 'missing-discovery' | 'unaddressed-risk';

const VERDICTS = new Set<CoachVerdict>(['advances', 'activity', 'missing-discovery', 'unaddressed-risk']);

export interface CoachDeal {
  id: string;
  crux: string;
  verdict: CoachVerdict;
  challenge: string;
}

export interface CoachResult {
  deals: CoachDeal[];
  themes: string[];
}

/** One deal as fed to the pass: structured facts + the rep narrative + call signals. */
export interface CoachDealInput {
  id: string;
  name: string;
  amount: number;
  stage: string;
  closeDate: string | null;
  nextStep: string | null;
  flags: string[];
  description: string;
  signals: TranscriptSignals | null;
}

export interface CoachPayload {
  rep: string;
  attainment: { quota: number; closedWon: number; gap: number; coverage: number };
  forecast: { commit: number; bestCase: number; commitAccuracy: number | null };
  deals: CoachDealInput[];
}

export const COACH_SYSTEM_PROMPT =
`You are a sales manager preparing for a 1:1 with one rep, inspecting their at-risk
deals to find what actually matters. You are not here to validate activity. Be
skeptical by default. A next step being specific or dated does not make it good:
sending a quote, booking a demo, or "pushing for a POV" is activity, not progress,
unless it moves the one thing currently gating the deal.

Your evidence, in order of trust:
1. The deal description: the rep's own running narrative. Treat it as a claim to
   verify, not fact, and weigh recency; old notes may be stale.
2. The transcript signals when present: what the calls actually showed
   (stakeholders, sentiment, competitors, commitments, risks). When the
   description and the signals disagree, the disagreement is usually the crux.
3. Stage and probability are not given to you on purpose. Do not assume a deal is
   healthy because it carries a late stage; judge from the narrative and signals.

For EACH deal return:
- "crux": the single thing that determines whether this deal closes in its
  timeframe, in one or two sentences. If qualification is unproven (no confirmed
  economic buyer, no established pain, no decision process, single-threaded, or
  threaded only through a partner), the crux IS that gap. Do not invent progress
  the evidence does not show.
- "verdict" on the current next step, exactly one of: "advances" (moves the crux),
  "activity" (motion that does not move the crux), "missing-discovery" (skips
  qualification the deal still needs), "unaddressed-risk" (ignores a risk,
  competitor, or broken commitment visible in the evidence).
- "challenge": the specific harder next step or discovery question the rep should
  commit to. Pointed and answerable, not "follow up". One or two sentences.

Then "themes": 2 to 3 patterns across the whole book, each with the evidence
behind it (for example several deals single-threaded through a partner, a commit
bar decoupled from reality, discovery consistently thin).

Return ONLY JSON, no prose and no markdown:
{"deals":[{"id":"<id>","crux":"...","verdict":"advances|activity|missing-discovery|unaddressed-risk","challenge":"..."}],"themes":["..."]}`;

export function buildCoachUserMessage(payload: CoachPayload): string {
  return JSON.stringify(payload);
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(s => s.trim());
}

/** Tolerantly parse the model's JSON; drop unknown ids and bad verdicts. */
export function parseCoachResponse(text: string, validIds: Set<string>): CoachResult {
  let obj: unknown;
  try {
    const m = text.match(/\{[\s\S]*\}/); // tolerate code fences / surrounding prose
    obj = JSON.parse(m ? m[0] : text);
  } catch {
    return { deals: [], themes: [] };
  }
  if (!obj || typeof obj !== 'object') return { deals: [], themes: [] };
  const o = obj as Record<string, unknown>;
  const deals: CoachDeal[] = [];
  if (Array.isArray(o.deals)) {
    for (const row of o.deals) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const id = r.id;
      const verdict = r.verdict;
      const crux = r.crux;
      const challenge = r.challenge;
      if (typeof id !== 'string' || !validIds.has(id)) continue;
      if (typeof verdict !== 'string' || !VERDICTS.has(verdict as CoachVerdict)) continue;
      deals.push({
        id,
        verdict: verdict as CoachVerdict,
        crux: typeof crux === 'string' ? crux.trim() : '',
        challenge: typeof challenge === 'string' ? challenge.trim() : '',
      });
    }
  }
  return { deals, themes: asStringArray(o.themes) };
}
