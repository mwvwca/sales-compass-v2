import { supabase } from '@/integrations/supabase/client';
import type { Transcript, TranscriptSignals } from './transcripts';

interface TranscriptRow {
  id: string;
  opp_id: string;
  created_at: string;
  raw_text: string;
  signals: TranscriptSignals;
}

// transcripts isn't in the generated Database type until `supabase gen types` is
// run from a Terminal (post-migration). Hand-type the row + use an untyped handle;
// de-cast to supabase.from(...) once types are regenerated.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const table = () => (supabase as any).from('transcripts');

function mapRow(r: TranscriptRow): Transcript {
  return { id: r.id, oppId: r.opp_id, createdAt: r.created_at, rawText: r.raw_text, signals: r.signals };
}

/** All transcripts for an opportunity, newest first. */
export async function loadTranscripts(oppId: string): Promise<Transcript[]> {
  const { data, error } = await table()
    .select('id, opp_id, created_at, raw_text, signals')
    .eq('opp_id', oppId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return ((data as TranscriptRow[] | null) ?? []).map(mapRow);
}

/** Append a transcript + its extracted signals (user_id stamped from the session). */
export async function saveTranscript(oppId: string, rawText: string, signals: TranscriptSignals): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('Not signed in');
  const { error } = await table().insert({ user_id: userId, opp_id: oppId, raw_text: rawText, signals });
  if (error) throw new Error(error.message);
}

/** Latest transcript's signals per opportunity, for feeding the risk flags. */
export async function loadCurrentSignalsByOpp(): Promise<Record<string, TranscriptSignals>> {
  const { data, error } = await table()
    .select('opp_id, created_at, signals')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  const out: Record<string, TranscriptSignals> = {};
  // Rows are newest-first, so the first row seen per opp_id is the latest.
  for (const row of (data as { opp_id: string; signals: TranscriptSignals }[] | null) ?? []) {
    if (!(row.opp_id in out)) out[row.opp_id] = row.signals;
  }
  return out;
}
