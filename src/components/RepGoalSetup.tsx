import { useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { Plus, Trash2, Check, X, Copy, ChevronDown, ChevronRight } from 'lucide-react';
import CommissionLock from '@/components/CommissionLock';
import CommissionSettings from '@/components/CommissionSettings';
import CommissionTracker from '@/components/CommissionTracker';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { normalizeRepName } from '@/lib/repUtils';

export default function RepGoalSetup() {
  const {
    reps,
    opportunities,
    addRep,
    updateRep,
    deleteRep,
    commissionSettings,
    commissionReviews,
    commissionPinHash,
    setCommissionSettings,
    clearCommissionSettings,
    updateCommissionMonthActual,
    updateCommissionOpportunityReview,
    updateOpportunityCommissionDetails,
    setCommissionPinHash,
  } = useForecast();
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editGoal, setEditGoal] = useState('');
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [commissionOpen, setCommissionOpen] = useState(false);

  const handleAdd = () => {
    if (!name.trim() || !goal) return;
    const goalValue = parseFloat(goal);
    const yearQuarters: Record<string, number> = {};
    for (let q = 1; q <= 4; q++) {
      yearQuarters[`${year}-Q${q}`] = goalValue;
    }
    const normalizedName = normalizeRepName(name);
    const existing = reps.find(r => normalizeRepName(r.name) === normalizedName);
    if (existing) {
      updateRep({ ...existing, quarterlyGoals: { ...existing.quarterlyGoals, ...yearQuarters } });
    } else {
      addRep({ id: crypto.randomUUID(), name: name.trim(), quarterlyGoals: yearQuarters });
    }
    setName('');
    setGoal('');
  };

  const startEdit = (repId: string, q: string, currentGoal: number) => {
    setEditingId(`${repId}-${q}`);
    setEditGoal(String(currentGoal));
  };

  const saveEdit = (rep: typeof reps[0], q: string, applyToAll = false) => {
    const value = parseFloat(editGoal);
    if (applyToAll) {
      const yr = q.split('-Q')[0];
      const allQ: Record<string, number> = {};
      for (let i = 1; i <= 4; i++) allQ[`${yr}-Q${i}`] = value;
      updateRep({ ...rep, quarterlyGoals: { ...rep.quarterlyGoals, ...allQ } });
    } else {
      updateRep({ ...rep, quarterlyGoals: { ...rep.quarterlyGoals, [q]: value } });
    }
    setEditingId(null);
  };

  const defaultQuarters = [1, 2, 3, 4].map(q => `${year}-Q${q}`);
  const quarters = Array.from(new Set([...defaultQuarters, ...reps.flatMap(r => Object.keys(r.quarterlyGoals))])).sort();

  return (
    <div className="space-y-8">
      <Collapsible open={goalsOpen} onOpenChange={setGoalsOpen} className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Rep quarterly goals</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Set each rep&apos;s quarterly target. Click a value to edit.</p>
          </div>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="gap-1.5">
              {goalsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              {goalsOpen ? 'Hide list' : 'Show list'}
            </Button>
          </CollapsibleTrigger>
        </div>

        <CollapsibleContent className="space-y-6">
          <div className="flex gap-3 items-end">
            <div className="flex-1 space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Rep Name</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Jane Smith"
                className="w-full bg-secondary border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div className="w-28 space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Year</label>
              <input
                value={year}
                onChange={e => setYear(e.target.value)}
                placeholder="2026"
                className="w-full bg-secondary border border-border rounded-md px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div className="w-36 space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Goal ($)</label>
              <input
                type="number"
                value={goal}
                onChange={e => setGoal(e.target.value)}
                placeholder="500000"
                className="w-full bg-secondary border border-border rounded-md px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <button onClick={handleAdd} className="flex items-center gap-1.5 bg-foreground text-background px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 transition-opacity">
              <Plus size={14} /> Add
            </button>
          </div>

          {reps.length > 0 && (
            <div className="border border-border rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-secondary/50">
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Rep</th>
                    {quarters.map(q => (
                      <th key={q} className="text-right px-4 py-2.5 text-xs font-mono font-medium text-muted-foreground uppercase tracking-wider">{q}</th>
                    ))}
                    <th className="w-12" />
                  </tr>
                </thead>
                <tbody>
                  {reps.map(rep => (
                    <tr key={rep.id} className="border-b border-border last:border-0 hover:bg-secondary/30 transition-colors">
                      <td className="px-4 py-2.5 font-medium">{rep.name}</td>
                      {quarters.map(q => {
                        const isEditing = editingId === `${rep.id}-${q}`;
                        const val = rep.quarterlyGoals[q];
                        return (
                          <td key={q} className="text-right px-4 py-2.5 font-mono">
                            {isEditing ? (
                              <span className="inline-flex items-center gap-1">
                                <input type="number" value={editGoal} onChange={e => setEditGoal(e.target.value)} className="w-24 bg-secondary border border-border rounded px-2 py-1 text-right text-sm font-mono" autoFocus />
                                <button onClick={() => saveEdit(rep, q)} title="Save this quarter" className="text-positive"><Check size={14} /></button>
                                <button onClick={() => saveEdit(rep, q, true)} title="Apply to all quarters this year" className="text-muted-foreground hover:text-foreground"><Copy size={14} /></button>
                                <button onClick={() => setEditingId(null)} className="text-negative"><X size={14} /></button>
                              </span>
                            ) : val !== undefined ? (
                              <span className="cursor-pointer hover:text-foreground text-secondary-foreground" onClick={() => startEdit(rep.id, q, val)}>
                                {val.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-2">
                        <button onClick={() => deleteRep(rep.id)} className="text-muted-foreground hover:text-negative transition-colors p-1">
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>

      <Collapsible open={commissionOpen} onOpenChange={setCommissionOpen} className="space-y-4 border-t border-border pt-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Monthly commission review</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Review the exact Closed Won deals behind each month’s expected payout and compare them to your company statement.</p>
          </div>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="gap-1.5">
              {commissionOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              {commissionOpen ? 'Hide review' : 'Show review'}
            </Button>
          </CollapsibleTrigger>
        </div>

        <CollapsibleContent>
          <CommissionLock pinHash={commissionPinHash} onPinHashChange={setCommissionPinHash}>
            <div className="space-y-6">
              <CommissionSettings
                reps={reps}
                commissionSettings={commissionSettings}
                onSave={setCommissionSettings}
                onClear={clearCommissionSettings}
              />
              <CommissionTracker
                reps={reps}
                opportunities={opportunities}
                commissionSettings={commissionSettings}
                commissionReviews={commissionReviews}
                onMonthActualChange={updateCommissionMonthActual}
                onOpportunityReviewChange={updateCommissionOpportunityReview}
                onOpportunityCommissionDetailsChange={updateOpportunityCommissionDetails}
              />
            </div>
          </CommissionLock>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
