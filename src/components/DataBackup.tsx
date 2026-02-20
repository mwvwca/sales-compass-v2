import { useForecast } from '@/context/ForecastContext';
import { Button } from '@/components/ui/button';
import { Download, Upload } from 'lucide-react';
import { useRef } from 'react';
import { useToast } from '@/hooks/use-toast';

export default function DataBackup() {
  const { reps, opportunities, imports, changelog, restoreFromBackup } = useForecast();
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleSave = () => {
    const backup = { reps, opportunities, imports, changelog, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `forecast-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: 'Backup saved', description: 'Your data has been downloaded as a JSON file.' });
  };

  const handleRestore = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (!data.reps || !data.opportunities) {
          toast({ title: 'Invalid backup', description: 'File does not contain valid forecast data.', variant: 'destructive' });
          return;
        }
        restoreFromBackup(data);
        toast({ title: 'Restored', description: `Data restored from ${file.name}` });
      } catch {
        toast({ title: 'Error', description: 'Could not parse backup file.', variant: 'destructive' });
      }
    };
    reader.readAsText(file);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={handleSave} className="text-xs gap-1.5">
        <Download size={12} /> Save Backup
      </Button>
      <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} className="text-xs gap-1.5">
        <Upload size={12} /> Restore
      </Button>
      <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={handleRestore} />
    </div>
  );
}
