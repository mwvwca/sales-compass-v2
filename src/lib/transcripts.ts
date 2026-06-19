// Pure transcript logic — types, the extraction prompt, a tolerant response
// parser, and the latest-signals selector. No supabase, no network (those live
// in ./transcriptsApi and ./transcriptsExtractApi).

export interface Stakeholder {
  name: string;
  role: string;
}

export type Sentiment = 'positive' | 'neutral' | 'negative';

export interface TranscriptSignals {
  stakeholders: Stakeholder[];
  sentiment: Sentiment;
  competitors: string[];
  commitments: string[];
  risks: string[];
}

export interface Transcript {
  id: string;
  oppId: string;
  createdAt: string;
  rawText: string;
  signals: TranscriptSignals;
}

export const EMPTY_SIGNALS: TranscriptSignals = {
  stakeholders: [],
  sentiment: 'neutral',
  competitors: [],
  commitments: [],
  risks: [],
};

export const EXTRACT_SYSTEM_PROMPT =
`You extract structured signals from a sales call transcript or meeting notes.
Return ONLY a JSON object — no prose, no markdown — matching exactly this shape:
{"stakeholders":[{"name":"...","role":"..."}],"sentiment":"positive"|"neutral"|"negative","competitors":["..."],"commitments":["..."],"risks":["..."]}
- stakeholders: customer-side people who spoke or were named, each with their role.
- sentiment: the customer's overall sentiment toward moving the deal forward.
- competitors: competing vendors or products mentioned.
- commitments: concrete commitments or next actions either side agreed to.
- risks: anything that could delay or kill the deal.
Use empty arrays and "neutral" when unknown. JSON only.`;

export function buildExtractUserMessage(rawText: string): string {
  return rawText;
}

const SENTIMENTS = new Set<Sentiment>(['positive', 'neutral', 'negative']);

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

function asStakeholders(v: unknown): Stakeholder[] {
  if (!Array.isArray(v)) return [];
  const out: Stakeholder[] = [];
  for (const s of v) {
    if (!s || typeof s !== 'object') continue;
    const name = (s as { name?: unknown }).name;
    const role = (s as { role?: unknown }).role;
    if (typeof name === 'string' && name.trim()) {
      out.push({ name: name.trim(), role: typeof role === 'string' ? role.trim() : '' });
    }
  }
  return out;
}

/** Tolerant parse of the model's JSON object → validated TranscriptSignals. */
export function parseExtractResponse(text: string): TranscriptSignals {
  let obj: unknown;
  try {
    const m = text.match(/\{[\s\S]*\}/); // tolerate code fences / surrounding prose
    obj = JSON.parse(m ? m[0] : text);
  } catch {
    return { ...EMPTY_SIGNALS };
  }
  if (!obj || typeof obj !== 'object') return { ...EMPTY_SIGNALS };
  const o = obj as Record<string, unknown>;
  const sentiment = typeof o.sentiment === 'string' && SENTIMENTS.has(o.sentiment as Sentiment)
    ? (o.sentiment as Sentiment)
    : 'neutral';
  return {
    stakeholders: asStakeholders(o.stakeholders),
    sentiment,
    competitors: asStringArray(o.competitors),
    commitments: asStringArray(o.commitments),
    risks: asStringArray(o.risks),
  };
}

/** Signals from the most recent transcript (by createdAt), or null when none. */
export function currentSignals(transcripts: Transcript[]): TranscriptSignals | null {
  if (transcripts.length === 0) return null;
  let latest = transcripts[0];
  for (const t of transcripts) {
    if (t.createdAt > latest.createdAt) latest = t;
  }
  return latest.signals;
}
