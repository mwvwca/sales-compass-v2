import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { loadTranscripts, saveTranscript } from '@/lib/transcriptsApi';
import { extractTranscriptSignals } from '@/lib/transcriptsExtractApi';
import { currentSignals, type Transcript } from '@/lib/transcripts';
import { SignalsView } from '@/components/SignalsView';

interface TranscriptDialogProps {
  oppId: string | null;
  name?: string;
  onClose: () => void;
}

export function TranscriptDialog({ oppId, name, onClose }: TranscriptDialogProps) {
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [rawText, setRawText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!oppId) return;
    let alive = true;
    setTranscripts([]);
    setRawText('');
    setError(null);
    loadTranscripts(oppId)
      .then(ts => { if (alive) setTranscripts(ts); })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [oppId]);

  async function handleExtractAndSave() {
    if (!oppId || !rawText.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const signals = await extractTranscriptSignals(rawText);
      await saveTranscript(oppId, rawText, signals);
      const ts = await loadTranscripts(oppId);
      setTranscripts(ts);
      setRawText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const current = currentSignals(transcripts);

  return (
    <Dialog open={!!oppId} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">Transcripts — {name}</DialogTitle>
        </DialogHeader>

        {current && (
          <div className="rounded-md border border-border bg-secondary/30 p-3">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Current signals</h4>
            <SignalsView signals={current} />
          </div>
        )}

        <Textarea
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          placeholder="Paste a call transcript or meeting notes..."
          className="min-h-[120px] text-sm"
          disabled={busy}
        />
        {error && <p className="text-xs text-negative">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Close</Button>
          <Button size="sm" onClick={handleExtractAndSave} disabled={busy || !rawText.trim()}>
            {busy ? 'Extracting…' : 'Extract & save'}
          </Button>
        </div>

        <div className="mt-2 pt-3 border-t border-border">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Transcript log</h4>
          {transcripts.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No transcripts captured yet.</p>
          ) : (
            <div className="space-y-3">
              {transcripts.map(t => {
                const d = new Date(t.createdAt);
                const label = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
                return (
                  <div key={t.id} className="border border-border rounded-md overflow-hidden">
                    <div className="bg-secondary/50 px-3 py-1.5 flex items-center justify-end text-[10px]">
                      <span className="text-muted-foreground font-mono">{label}</span>
                    </div>
                    <div className="px-3 py-2 space-y-2">
                      <SignalsView signals={t.signals} />
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-4">{t.rawText}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
