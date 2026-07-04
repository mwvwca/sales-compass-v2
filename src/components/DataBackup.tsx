import { useForecast } from '@/context/ForecastContext';
import { useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { downloadBackupNow } from '@/lib/backupUtils';
import { backupSchema, type BackupData } from '@/lib/backupSchema';
import { loadCurrentSignalsByOpp, loadAllTranscripts } from '@/lib/transcriptsApi';
import type { Transcript, TranscriptSignals } from '@/lib/transcripts';

export function useDataBackup() {
  const {
    reps,
    opportunities,
    imports,
    changelog,
    snapshots,
    monthlyRepCommits,
    monthlyManagerCommits,
    forecastPromotions,
    forecastSnapshots,
    managerQuotas,
    weeklySnapshots,
    dealRegistrations,
    drBatches,
    restoreFromBackup,
  } = useForecast();
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const [pendingRestore, setPendingRestore] = useState<{
    data: BackupData;
    fileName: string;
  } | null>(null);

  const handleSave = async () => {
    // Transcripts and signals live in Supabase, not app_state, so pull them in
    // at export time. Fail soft: a backup is still useful without them offline.
    let signals: Record<string, TranscriptSignals> = {};
    let transcripts: Transcript[] = [];
    try { signals = await loadCurrentSignalsByOpp(); } catch { /* omit signals offline */ }
    try { transcripts = await loadAllTranscripts(); } catch { /* omit transcripts offline */ }
    downloadBackupNow({
      reps, opportunities, imports, changelog, snapshots, monthlyRepCommits,
      monthlyManagerCommits, forecastPromotions, forecastSnapshots, managerQuotas,
      weeklySnapshots, dealRegistrations, drBatches, signals, transcripts,
    });
    toast({ title: 'Backup saved', description: 'Your data has been downloaded as a JSON file.' });
  };

  const handleRestore = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const raw = JSON.parse(ev.target?.result as string);
        const result = backupSchema.safeParse(raw);
        if (!result.success) {
          const firstError = result.error.issues[0];
          toast({
            title: 'Invalid backup',
            description: `Validation failed: ${firstError.path.join('.')}: ${firstError.message}`,
            variant: 'destructive',
          });
          return;
        }
        // Restoring replaces the working dataset and cloud sync propagates the
        // overwrite everywhere, so it never applies without explicit confirmation.
        setPendingRestore({ data: result.data, fileName: file.name });
      } catch {
        toast({ title: 'Error', description: 'Could not parse backup file.', variant: 'destructive' });
      }
    };
    reader.readAsText(file);
    if (fileRef.current) fileRef.current.value = '';
  };

  // The hidden input must stay mounted in a stable spot in the tree (NOT inside a
  // dropdown menu that unmounts on close), so callers render `restoreInput` directly.
  const restoreInput = (
    <>
      <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={handleRestore} />
      <Dialog open={!!pendingRestore} onOpenChange={open => { if (!open) setPendingRestore(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Replace all data with this backup?</DialogTitle>
            <DialogDescription className="text-xs">
              This replaces your working dataset on this device and syncs the replacement to the cloud. It cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {pendingRestore && (
            <div className="text-xs space-y-1.5">
              <div className="grid grid-cols-3 gap-2 font-medium text-muted-foreground">
                <span></span><span className="text-right">Current</span><span className="text-right">Backup</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <span>Opportunities</span>
                <span className="text-right">{opportunities.length.toLocaleString()}</span>
                <span className="text-right">{pendingRestore.data.opportunities.length.toLocaleString()}</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <span>Deal registrations</span>
                <span className="text-right">{dealRegistrations.length.toLocaleString()}</span>
                <span className="text-right">{(pendingRestore.data.dealRegistrations?.length ?? 0).toLocaleString()}</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <span>History snapshots</span>
                <span className="text-right">{snapshots.length.toLocaleString()}</span>
                <span className="text-right">{(pendingRestore.data.snapshots?.length ?? 0).toLocaleString()}</span>
              </div>
              <p className="text-muted-foreground pt-1">
                File: {pendingRestore.fileName}
                {pendingRestore.data.exportedAt ? ` · exported ${String(pendingRestore.data.exportedAt).slice(0, 10)}` : ''}
              </p>
              {(pendingRestore.data.snapshots?.length ?? 0) === 0 && (
                <p className="text-amber-600 dark:text-amber-500">This backup contains no history snapshots; existing deal history on this device will be kept.</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingRestore(null)}>Cancel</Button>
            <Button size="sm" variant="destructive" onClick={() => {
              if (!pendingRestore) return;
              restoreFromBackup(pendingRestore.data as any);
              toast({ title: 'Restored', description: `Data restored from ${pendingRestore.fileName}` });
              setPendingRestore(null);
            }}>Replace data</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
  const openRestore = () => fileRef.current?.click();

  return { handleSave, openRestore, restoreInput };
}
