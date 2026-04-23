import { useEffect, useMemo, useState } from 'react';
import { Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CommissionSettingsMap, Rep } from '@/types/forecast';
import { normalizeRepName } from '@/lib/repUtils';

interface CommissionSettingsProps {
  reps: Rep[];
  commissionSettings: CommissionSettingsMap;
  onSave: (repName: string, settings: { monthlyQuota: number; baseRate: number }) => void;
  onClear: (repName: string) => void;
}

interface DraftRow {
  monthlyQuota: string;
  baseRate: string;
}

export default function CommissionSettings({ reps, commissionSettings, onSave, onClear }: CommissionSettingsProps) {
  const [drafts, setDrafts] = useState<Record<string, DraftRow>>({});

  const initialDrafts = useMemo(() => {
    return reps.reduce<Record<string, DraftRow>>((accumulator, rep) => {
      const existing = commissionSettings[normalizeRepName(rep.name)];
      accumulator[rep.id] = {
        monthlyQuota: existing?.monthlyQuota ? String(existing.monthlyQuota) : '',
        baseRate: existing?.baseRate ? String(existing.baseRate * 100) : '',
      };
      return accumulator;
    }, {});
  }, [commissionSettings, reps]);

  useEffect(() => {
    setDrafts(initialDrafts);
  }, [initialDrafts]);

  const updateDraft = (repId: string, field: keyof DraftRow, value: string) => {
    setDrafts(current => ({
      ...current,
      [repId]: {
        ...current[repId],
        [field]: value,
      },
    }));
  };

  const handleSave = (rep: Rep) => {
    const draft = drafts[rep.id];
    const monthlyQuota = Number(draft?.monthlyQuota || 0);
    const baseRatePct = Number(draft?.baseRate || 0);

    onSave(rep.name, {
      monthlyQuota: Number.isFinite(monthlyQuota) ? monthlyQuota : 0,
      baseRate: Number.isFinite(baseRatePct) ? baseRatePct / 100 : 0,
    });
  };

  if (reps.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
        Add reps above to configure monthly quotas and payout rates.
      </div>
    );
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Commission settings</h3>
        <p className="text-xs text-muted-foreground">Set each rep’s monthly quota and base commission rate used for expected payout math.</p>
      </div>

      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/40 text-left">
              <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Rep</th>
              <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Monthly Quota</th>
              <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Base Rate %</th>
              <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {reps.map(rep => {
              const repKey = normalizeRepName(rep.name);
              const configured = commissionSettings[repKey];

              return (
                <tr key={rep.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-medium text-foreground">{rep.name}</td>
                  <td className="px-4 py-3">
                    <Input
                      type="number"
                      value={drafts[rep.id]?.monthlyQuota || ''}
                      onChange={event => updateDraft(rep.id, 'monthlyQuota', event.target.value)}
                      placeholder="500000"
                      className="font-mono"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <Input
                      type="number"
                      step="0.01"
                      value={drafts[rep.id]?.baseRate || ''}
                      onChange={event => updateDraft(rep.id, 'baseRate', event.target.value)}
                      placeholder="10"
                      className="font-mono"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={() => handleSave(rep)}>
                        <Save className="mr-1.5 h-3.5 w-3.5" /> Save
                      </Button>
                      {configured && (
                        <Button type="button" variant="outline" size="sm" onClick={() => onClear(rep.name)}>
                          <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Clear
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
