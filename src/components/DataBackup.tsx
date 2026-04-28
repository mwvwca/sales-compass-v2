import { useForecast } from '@/context/ForecastContext';
import { Button } from '@/components/ui/button';
import { Download, Upload } from 'lucide-react';
import { useRef } from 'react';
import { useToast } from '@/hooks/use-toast';
import { z } from 'zod';

const classificationEnum = z.enum(['commit', 'upside', 'closed_won', 'unclassified', 'lost', 'omitted']);

const repSchema = z.object({
  id: z.string(),
  name: z.string().max(200),
  quarterlyGoals: z.record(z.string(), z.number().finite().min(0)),
});

const opportunitySchema = z.object({
  id: z.string(),
  name: z.string().max(500),
  repId: z.string(),
  repName: z.string().max(200),
  amount: z.number().finite().min(0),
  closeDate: z.string(),
  stage: z.string().max(200),
  classification: classificationEnum,
  probability: z.number().finite().min(0).max(100),
  importDate: z.string(),
  previousClassification: classificationEnum.optional(),
  lostDate: z.string().optional(),
  lostReason: z.string().max(500).optional(),
  movedAt: z.string().optional(),
  notes: z.string().max(4000).optional(),
  commissionMrr: z.number().finite().min(0).optional(),
  commissionTermYears: z.number().finite().min(1).max(10).optional(),
  commissionPaymentType: z.enum(['annual', 'upfront']).optional(),
  commissionSpiff: z.number().finite().min(0).optional(),
  commissionNotes: z.string().max(4000).optional(),
  accountName: z.string().max(500).optional(),
  productName: z.string().max(500).optional(),
});

const importRecordSchema = z.object({
  id: z.string(),
  date: z.string(),
  fileName: z.string().max(500),
  opportunityCount: z.number().finite().min(0),
});

const changeLogSchema = z.object({
  id: z.string(),
  importDate: z.string(),
  fileName: z.string().max(500),
  opportunityId: z.string(),
  opportunityName: z.string().max(500),
  repName: z.string().max(200),
  field: z.enum(['closeDate', 'amount', 'stage', 'classification', 'name', 'repName']),
  oldValue: z.string(),
  newValue: z.string(),
});

const commissionSettingSchema = z.object({
  monthlyQuota: z.number().finite().min(0),
  annualVariableComp: z.number().finite().min(0).optional(),
  priorQuarterPayout: z.number().finite().min(0).optional(),
  baseRate: z.number().finite().min(0).max(1).optional(),
});

const commissionOpportunityReviewSchema = z.object({
  actualCommission: z.number().finite().min(0).optional(),
  note: z.string().max(4000).optional(),
});

const commissionMonthlyReviewSchema = z.object({
  repKey: z.string().max(200),
  repName: z.string().max(200),
  monthKey: z.string().regex(/^\d{4}-\d{2}$/),
  actualTotal: z.number().finite().min(0).optional(),
  opportunities: z.record(z.string(), commissionOpportunityReviewSchema),
});

const backupSchema = z.object({
  reps: z.array(repSchema).max(1000),
  opportunities: z.array(opportunitySchema).max(10000),
  imports: z.array(importRecordSchema).max(1000).optional(),
  changelog: z.array(changeLogSchema).max(50000).optional(),
  commissionSettings: z.record(z.string(), commissionSettingSchema).optional(),
  commissionReviews: z.record(z.string(), commissionMonthlyReviewSchema).optional(),
  commissionPinHash: z.string().max(256).nullable().optional(),
  exportedAt: z.string().optional(),
});

export default function DataBackup() {
  const {
    reps,
    opportunities,
    imports,
    changelog,
    commissionSettings,
    commissionReviews,
    commissionPinHash,
    restoreFromBackup,
  } = useForecast();
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleSave = () => {
    const backup = {
      reps,
      opportunities,
      imports,
      changelog,
      commissionSettings,
      commissionReviews,
      commissionPinHash,
      exportedAt: new Date().toISOString(),
    };
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
        const raw = JSON.parse(ev.target?.result as string);
        const result = backupSchema.safeParse(raw);
        if (!result.success) {
          const firstError = result.error.issues[0];
          toast({
            title: 'Invalid backup',
            description: `Validation failed: ${firstError.path.join('.')} — ${firstError.message}`,
            variant: 'destructive',
          });
          return;
        }
        restoreFromBackup(result.data as any);
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
