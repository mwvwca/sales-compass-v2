import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { Plus, Trash2, Check, X, Copy, ChevronDown, ChevronRight, Target, RotateCcw, Camera, Star, Eye } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import CommissionLock from '@/components/CommissionLock';
import CommissionSettings from '@/components/CommissionSettings';
import CommissionTracker from '@/components/CommissionTracker';
import CommissionReconciliation from '@/components/CommissionReconciliation';
import ForecastSnapshotView from '@/components/ForecastSnapshot';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { normalizeRepName } from '@/lib/repUtils';
import { useToast } from '@/hooks/use-toast';
import { downloadBackupNow } from '@/lib/backupUtils';
import { getMonthLabel, getMonthKey, getQuarter, getWeeksInMonth, getDateAtUtcStart, type ForecastSnapshot } from '@/types/forecast';

export default function RepGoalSetup() {
  const {
    reps,
    opportunities,
    imports,
    changelog,
    snapshots,
    addRep,
    updateRep,
    deleteRep,
    setRepActiveStatus,
    commissionSettings,
    commissionReviews,
    commissionPinHash,
    setCommissionSettings,
    clearCommissionSettings,
    updateCommissionMonthActual,
    updateCommissionOpportunityReview,
    updateOpportunityCommissionDetails,
    setCommissionPinHash,
    monthlyRepCommits,
    monthlyManagerCommits,
    forecastPromotions,
    forecastSnapshots,
    managerQuotas,
    setManagerQuota,
    getManagerQuota,
    setMonthlyRepCommit,
    getMonthlyRepCommit,
    setMonthlyManagerCommit,
    getMonthlyManagerCommit,
    promoteOpportunityForecast,
    demoteOpportunityForecast,
    isOpportunityPromoted,
    createForecastSnapshot,
    reconcileForecastSnapshot,
    deleteForecastSnapshot,
  } = useForecast();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editGoal, setEditGoal] = useState('');
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [commissionOpen, setCommissionOpen] = useState(false);
  const [mgmtOpen, setMgmtOpen] = useState(false);
  const [mgrCommitDraft, setMgrCommitDraft] = useState<string>('');
  const [mgrCommitDraftKey, setMgrCommitDraftKey] = useState<string>('');
  const [dealListOpen, setDealListOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewingSnapshot, setViewingSnapshot] = useState<ForecastSnapshot | null>(null);

  // Manager quota state
  const currentYear = new Date().getFullYear();
  const [mqYear, setMqYear] = useState<number>(currentYear);
  const mqRecord = getManagerQuota(mqYear);
  const [mqAmountDraft, setMqAmountDraft] = useState<string>('');
  const [mqNotesDraft, setMqNotesDraft] = useState<string>('');
  const [mqYearKey, setMqYearKey] = useState<number>(mqYear);
  const effectiveMqAmount = mqYearKey === mqYear ? mqAmountDraft : (mqRecord ? String(mqRecord.annualAmount) : '');
  const effectiveMqNotes = mqYearKey === mqYear ? mqNotesDraft : (mqRecord?.notes ?? '');

  const yearOptions = useMemo(() => {
    const list: number[] = [];
    for (let y = currentYear - 2; y <= currentYear + 3; y++) list.push(y);
    return list;
  }, [currentYear]);

  const handleSaveManagerQuota = () => {
    const amount = parseFloat(effectiveMqAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      toast({ title: 'Invalid amount', description: 'Enter a non-negative number.', variant: 'destructive' });
      return;
    }
    setManagerQuota(mqYear, amount, effectiveMqNotes);
    triggerBackup();
    toast({ title: 'Manager quota saved and backup downloaded' });
  };


  // Monthly commit selector — single month at a time
  const currentMonthKey = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
  const [selectedMonth, setSelectedMonth] = useState<string>(currentMonthKey);
  const isCurrentMonth = selectedMonth === currentMonthKey;

  // Build a 24-month rolling option list centered on now
  const monthOptions = useMemo(() => {
    const list: string[] = [];
    const now = new Date();
    for (let i = -6; i <= 17; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      list.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    return list;
  }, []);

  // Per-rep draft inputs keyed by `${repId}::${monthKey}`
  const [drafts, setDrafts] = useState<Record<string, { amount: string; notes: string }>>({});
  const draftKey = (repId: string, mk: string) => `${repId}::${mk}`;
  const getDraft = (repId: string, mk: string) => {
    const k = draftKey(repId, mk);
    if (drafts[k]) return drafts[k];
    const existing = getMonthlyRepCommit(repId, mk);
    return { amount: existing ? String(existing.commitAmount) : '', notes: existing?.notes ?? '' };
  };
  const setDraft = (repId: string, mk: string, patch: Partial<{ amount: string; notes: string }>) => {
    const k = draftKey(repId, mk);
    const current = getDraft(repId, mk);
    setDrafts(d => ({ ...d, [k]: { ...current, ...patch } }));
  };

  const triggerBackup = () => {
    downloadBackupNow({
      reps,
      opportunities,
      imports,
      changelog,
      snapshots,
      commissionSettings,
      commissionReviews,
      commissionPinHash,
      monthlyRepCommits,
      monthlyManagerCommits,
      forecastPromotions,
      forecastSnapshots,
      managerQuotas,
    });
  };

  const handleSaveRepCommit = (repId: string, repName: string, mk: string) => {
    const d = getDraft(repId, mk);
    const amount = parseFloat(d.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      toast({ title: 'Invalid amount', description: 'Enter a non-negative number.', variant: 'destructive' });
      return;
    }
    setMonthlyRepCommit(repId, repName, mk, amount, d.notes);
    triggerBackup();
    toast({ title: 'Commit saved and backup downloaded.' });
  };

  const fmtTs = (iso?: string) => iso ? new Date(iso).toLocaleString() : '';
  const fmtMoney = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  // Rollup for selected month
  const rollup = useMemo(() => {
    const commitTotal = monthlyRepCommits
      .filter(m => m.monthKey === selectedMonth)
      .reduce((s, m) => s + m.commitAmount, 0);
    const quarter = getQuarter(`${selectedMonth}-01T00:00:00Z`);
    const quotaTotal = reps.reduce((s, r) => s + ((r.quarterlyGoals[quarter] || 0) / 3), 0);
    const gap = quotaTotal - commitTotal;
    return { commitTotal, quotaTotal, gap };
  }, [monthlyRepCommits, selectedMonth, reps]);

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
      addRep({ id: crypto.randomUUID(), name: name.trim(), quarterlyGoals: yearQuarters, isActive: true });
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

  // ----- Active/Inactive partitioning -----
  const isRepActive = (r: typeof reps[0]) => r.isActive !== false;
  const activeReps = useMemo(() => reps.filter(isRepActive), [reps]);
  const inactiveReps = useMemo(() => reps.filter(r => !isRepActive(r)), [reps]);

  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);
  const [deactivateNote, setDeactivateNote] = useState('');
  const deactivateNoteRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (deactivateNoteRef.current) {
      deactivateNoteRef.current.style.height = 'auto';
      deactivateNoteRef.current.style.height = `${deactivateNoteRef.current.scrollHeight}px`;
    }
  }, [deactivateNote, deactivatingId]);

  const openDeactivate = (repId: string) => {
    setDeactivatingId(repId);
    setDeactivateNote('');
  };
  const confirmDeactivate = (rep: typeof reps[0]) => {
    setRepActiveStatus(rep.id, false, deactivateNote);
    setDeactivatingId(null);
    setDeactivateNote('');
    toast({ title: `${rep.name} marked inactive`, description: 'Historical data preserved.' });
  };
  const reactivate = (rep: typeof reps[0]) => {
    setRepActiveStatus(rep.id, true);
    toast({ title: `${rep.name} reactivated` });
  };

  // ----- Manager commit draft -----
  const managerCommit = getMonthlyManagerCommit(selectedMonth);
  const effectiveMgrDraft = mgrCommitDraftKey === selectedMonth
    ? mgrCommitDraft
    : (managerCommit ? String(managerCommit.commitAmount) : '');

  const handleSaveManagerCommit = () => {
    const amount = parseFloat(effectiveMgrDraft);
    if (!Number.isFinite(amount) || amount < 0) {
      toast({ title: 'Invalid amount', description: 'Enter a non-negative number.', variant: 'destructive' });
      return;
    }
    setMonthlyManagerCommit(selectedMonth, amount);
    triggerBackup();
    toast({ title: 'Commit saved and backup downloaded' });
  };

  // ----- Forecast deal list -----
  const weeks = useMemo(() => getWeeksInMonth(selectedMonth), [selectedMonth]);
  const activeRepSet = useMemo(() => new Set(activeReps.map(r => r.name)), [activeReps]);

  const monthDeals = useMemo(() => {
    const promotedSet = new Set(
      forecastPromotions.filter(p => p.monthKey === selectedMonth).map(p => p.opportunityId),
    );
    const isExcluded = (o: typeof opportunities[0]) => {
      const s = (o.stage || '').toLowerCase().trim();
      return o.classification === 'lost' || o.classification === 'rejected' || o.classification === 'omitted'
        || s === 'closed lost' || s === 'rejected';
    };
    const list = opportunities
      .filter(o => o.closeDate && getMonthKey(o.closeDate) === selectedMonth && !isExcluded(o))
      .filter(o => activeRepSet.has(o.repName));
    return list.map(o => {
      const d = getDateAtUtcStart(o.closeDate);
      const w = weeks.find(x => d >= x.start && d <= x.end);
      const promoted = promotedSet.has(o.id);
      return {
        opp: o,
        weekLabel: w?.label ?? '—',
        promoted,
        isCommit: o.classification === 'commit',
        isUpside: o.classification === 'upside',
      };
    });
  }, [opportunities, selectedMonth, forecastPromotions, activeRepSet, weeks]);

  const dealTotals = useMemo(() => {
    let commit = 0;
    let promoted = 0;
    for (const d of monthDeals) {
      if (d.isCommit) commit += d.opp.amount;
      else if (d.promoted) promoted += d.opp.amount;
    }
    return { commit, promoted, total: commit + promoted };
  }, [monthDeals]);

  const mgrSaved = !!managerCommit;
  const mgrAmount = managerCommit?.commitAmount ?? 0;
  const mgrGap = mgrAmount - rollup.commitTotal;
  const mgrGapColor = !mgrSaved ? 'text-muted-foreground'
    : mgrGap > 0 ? 'text-positive'
    : Math.abs(mgrGap) <= rollup.commitTotal * 0.1 ? 'text-amber-500'
    : 'text-negative';

  const callVsMgr = mgrSaved
    ? (Math.abs(dealTotals.total - mgrAmount) <= mgrAmount * 0.05
        ? { color: 'text-positive', icon: '✓' as const }
        : { color: 'text-amber-500', icon: '⚠' as const })
    : { color: 'text-negative', icon: '✗' as const };

  // ----- Snapshots for selected month -----
  const monthSnapshots = useMemo(
    () => forecastSnapshots
      .filter(s => s.monthKey === selectedMonth)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [forecastSnapshots, selectedMonth],
  );

  const dealsByRep = useMemo(() => {
    const map = new Map<string, typeof monthDeals>();
    for (const d of monthDeals) {
      if (!d.isCommit && !d.promoted && !d.isUpside) continue;
      const arr = map.get(d.opp.repName) ?? [];
      arr.push(d);
      map.set(d.opp.repName, arr);
    }
    return Array.from(map.entries());
  }, [monthDeals]);
  const dealsByRepEntries = (entries: typeof dealsByRep) => entries;

  const handleSnapshot = () => {
    const snap = createForecastSnapshot(selectedMonth);
    triggerBackup();
    setViewingSnapshot(snap);
    toast({ title: 'Snapshot saved' });
  };

  const handleTogglePromote = (oppId: string, promoted: boolean) => {
    if (promoted) demoteOpportunityForecast(oppId, selectedMonth);
    else promoteOpportunityForecast(oppId, selectedMonth);
  };



  // Reps to show in the monthly commit grid:
  // - current/future months: only active reps
  // - past months: active reps + inactive reps that have a saved commit for that month
  const commitGridReps = useMemo(() => {
    if (selectedMonth >= currentMonthKey) return activeReps;
    const inactiveWithHistory = inactiveReps.filter(r => !!getMonthlyRepCommit(r.id, selectedMonth));
    return [...activeReps, ...inactiveWithHistory];
  }, [activeReps, inactiveReps, selectedMonth, currentMonthKey, monthlyRepCommits]);

  const renderRepGoalRow = (rep: typeof reps[0]) => {
    const inactive = !isRepActive(rep);
    const isConfirming = deactivatingId === rep.id;
    return (
      <React.Fragment key={rep.id}>
        <tr className={`border-b border-border last:border-0 hover:bg-secondary/30 transition-colors ${inactive ? 'opacity-60' : ''}`}>
          <td className="px-4 py-2.5 font-medium">
            <div className="flex items-center gap-2">
              <span>{rep.name}</span>
              {inactive ? (
                <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-border text-muted-foreground bg-muted/40">
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" /> Inactive
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-positive/40 text-positive bg-positive/10">
                  <span className="h-1.5 w-1.5 rounded-full bg-positive" /> Active
                </span>
              )}
            </div>
            {inactive && rep.inactivatedNote && (
              <p className="mt-1 text-[11px] text-muted-foreground italic max-w-md whitespace-pre-wrap">{rep.inactivatedNote}</p>
            )}
            {inactive && rep.inactivatedAt && (
              <p className="text-[10px] text-muted-foreground">Marked inactive {new Date(rep.inactivatedAt).toLocaleDateString()}</p>
            )}
          </td>
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
            <div className="flex items-center justify-end gap-1">
              {inactive ? (
                <button
                  onClick={() => reactivate(rep)}
                  title="Reactivate rep"
                  className="text-muted-foreground hover:text-positive transition-colors p-1 inline-flex items-center gap-1 text-[11px]"
                >
                  <RotateCcw size={12} /> Reactivate
                </button>
              ) : (
                <button
                  onClick={() => openDeactivate(rep.id)}
                  title="Mark inactive"
                  className="text-muted-foreground hover:text-foreground transition-colors p-1 text-[11px]"
                >
                  Mark inactive
                </button>
              )}
              <button onClick={() => deleteRep(rep.id)} title="Delete rep" className="text-muted-foreground hover:text-negative transition-colors p-1">
                <Trash2 size={14} />
              </button>
            </div>
          </td>
        </tr>
        {isConfirming && (
          <tr className="bg-secondary/40 border-b border-border">
            <td colSpan={quarters.length + 2} className="px-4 py-3">
              <div className="space-y-2 max-w-2xl">
                <p className="text-xs font-medium text-foreground">Mark {rep.name} as inactive?</p>
                <Textarea
                  ref={deactivateNoteRef}
                  placeholder="Note (e.g. left team, territory reassigned)"
                  value={deactivateNote}
                  onChange={(e) => setDeactivateNote(e.target.value)}
                  className="min-h-[60px] resize-none overflow-hidden text-xs"
                  onInput={(e) => {
                    const target = e.target as HTMLTextAreaElement;
                    target.style.height = 'auto';
                    target.style.height = `${target.scrollHeight}px`;
                  }}
                />
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => confirmDeactivate(rep)}>
                    <Check size={12} className="mr-1" /> Confirm
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setDeactivatingId(null); setDeactivateNote(''); }}>
                    Cancel
                  </Button>
                </div>
              </div>
            </td>
          </tr>
        )}
      </React.Fragment>
    );
  };

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
                  {activeReps.map(rep => renderRepGoalRow(rep))}
                  {inactiveReps.length > 0 && (
                    <tr className="bg-muted/30 border-b border-border">
                      <td colSpan={quarters.length + 2} className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                        Inactive reps — historical data preserved
                      </td>
                    </tr>
                  )}
                  {inactiveReps.map(rep => renderRepGoalRow(rep))}
                </tbody>
              </table>
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>

      {/* Monthly Management Commits per Rep */}
      <Collapsible open={mgmtOpen} onOpenChange={setMgmtOpen} className="space-y-4 border-t border-border pt-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-2">
            <Target className="h-4 w-4 mt-0.5 text-commit" />
            <div className="flex items-center gap-2 flex-wrap">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Monthly management commits</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">What you committed to leadership per rep this month. Set at the start of each month.</p>
              </div>
              {isCurrentMonth && (
                <span className="text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded-full border border-primary/60 text-primary bg-primary/10">
                  Current month
                </span>
              )}
            </div>
          </div>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="gap-1.5">
              {mgmtOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              {mgmtOpen ? 'Hide' : 'Show'}
            </Button>
          </CollapsibleTrigger>
        </div>

        <CollapsibleContent className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Month</label>
            <select
              value={selectedMonth}
              onChange={e => setSelectedMonth(e.target.value)}
              className="bg-secondary border border-border rounded-md px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {monthOptions.map(mk => (
                <option key={mk} value={mk}>{getMonthLabel(mk)}</option>
              ))}
            </select>
          </div>

          {/* My Number — manager-level commit override */}
          <div className="rounded-lg border-2 border-primary/60 bg-primary/5 p-4 space-y-2">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">My commit to leadership</p>
                <p className="text-xs text-muted-foreground">{getMonthLabel(selectedMonth)}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative flex-1 max-w-xs">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                <input
                  type="number"
                  value={effectiveMgrDraft}
                  onChange={e => { setMgrCommitDraftKey(selectedMonth); setMgrCommitDraft(e.target.value); }}
                  placeholder="Enter your number"
                  className="w-full bg-background border border-border rounded-md pl-7 pr-3 py-2 text-base font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
              <Button onClick={handleSaveManagerCommit} size="sm" className="gap-1.5">
                <Check size={14} /> Save
              </Button>
            </div>
            <div className="flex items-center gap-4 text-xs flex-wrap">
              <span className="text-muted-foreground">Rep rollup: <span className="font-mono text-foreground">{fmtMoney(rollup.commitTotal)}</span></span>
              <span className={mgrGapColor}>
                Gap: <span className="font-mono">{mgrSaved ? (mgrGap >= 0 ? '+' : '') + fmtMoney(mgrGap) : '—'}</span>
              </span>
              {managerCommit?.updatedAt && (
                <span className="text-muted-foreground ml-auto">Last saved: {fmtTs(managerCommit.updatedAt)}</span>
              )}
            </div>
          </div>



          {commitGridReps.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              {reps.length === 0 ? 'Add reps above first.' : 'No active reps for this month.'}
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {commitGridReps.map(rep => {
                const existing = getMonthlyRepCommit(rep.id, selectedMonth);
                const draft = getDraft(rep.id, selectedMonth);
                const inactive = !isRepActive(rep);
                return (
                  <RepCommitCard
                    key={rep.id}
                    repName={rep.name}
                    inactive={inactive}
                    existingAmount={existing?.commitAmount}
                    existingUpdatedAt={existing?.updatedAt}
                    draft={draft}
                    onChangeAmount={(v) => setDraft(rep.id, selectedMonth, { amount: v })}
                    onChangeNotes={(v) => setDraft(rep.id, selectedMonth, { notes: v })}
                    onSave={() => handleSaveRepCommit(rep.id, rep.name, selectedMonth)}
                    fmtMoney={fmtMoney}
                    fmtTs={fmtTs}
                  />
                );
              })}
            </div>
          )}

          {/* Rollup */}
          {reps.length > 0 && (
            <div className="border border-border rounded-md p-3 bg-secondary/30 grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total commit</p>
                <p className="text-sm font-mono font-semibold text-commit">{fmtMoney(rollup.commitTotal)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">AE quota total</p>
                <p className="text-sm font-mono font-semibold">{fmtMoney(rollup.quotaTotal)}</p>
                <p className="text-[10px] text-muted-foreground">Q goal ÷ 3</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Gap</p>
                <p className={`text-sm font-mono font-semibold ${rollup.gap > 0 ? 'text-negative' : 'text-positive'}`}>
                  {fmtMoney(rollup.gap)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {rollup.gap > 0 ? 'Commits below quota' : 'Commits meet/exceed quota'}
                </p>
              </div>
            </div>
          )}

          {/* Forecast deal list */}
          <Collapsible open={dealListOpen} onOpenChange={setDealListOpen} className="space-y-3 border-t border-border pt-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Forecast deal list</h3>
                <p className="text-xs text-muted-foreground">Deals making up your commit. Promote upside deals you're willing to call.</p>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" className="gap-1.5" onClick={handleSnapshot}>
                  <Camera size={14} /> Snapshot
                </Button>
                <CollapsibleTrigger asChild>
                  <Button size="sm" variant="outline" className="gap-1.5">
                    {dealListOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    {dealListOpen ? 'Hide' : 'Show'}
                  </Button>
                </CollapsibleTrigger>
              </div>
            </div>
            <CollapsibleContent className="space-y-3">
              {dealsByRepEntries(dealsByRep).length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No commit or upside deals for active reps in this month.</p>
              ) : (
                <div className="space-y-3">
                  {dealsByRepEntries(dealsByRep).map(([repName, list]) => (
                    <div key={repName} className="border border-border rounded-md overflow-hidden">
                      <div className="bg-secondary/40 px-3 py-1.5 text-xs font-semibold">{repName}</div>
                      {weeks.map(w => {
                        const wkList = list.filter(d => d.weekLabel === w.label);
                        if (wkList.length === 0) return null;
                        return (
                          <div key={w.label}>
                            <div className="bg-muted/30 px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">{w.label}</div>
                            {wkList.map(d => (
                              <div key={d.opp.id} className="flex items-center gap-2 px-3 py-1.5 text-xs border-t border-border/60">
                                <span className={`h-2 w-2 rounded-full ${d.isCommit ? 'bg-positive' : d.promoted ? 'bg-amber-400' : 'bg-amber-500/60'}`} />
                                {d.promoted && <Star size={12} className="text-amber-500 fill-amber-500" />}
                                <span className="flex-1 truncate">{d.opp.name}</span>
                                <span className="font-mono text-muted-foreground">{fmtMoney(d.opp.amount)}</span>
                                <span className="text-muted-foreground w-20 text-right">{d.opp.closeDate?.slice(0, 10)}</span>
                                <span className="text-muted-foreground w-24 truncate text-right">{d.opp.stage}</span>
                                {d.isUpside && (
                                  <button
                                    onClick={() => handleTogglePromote(d.opp.id, d.promoted)}
                                    className={`text-[10px] px-2 py-0.5 rounded border ${d.promoted ? 'border-amber-400 text-amber-500' : 'border-border text-muted-foreground hover:text-foreground'}`}
                                  >
                                    {d.promoted ? '★ Demote' : 'Promote ★'}
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}

              <div className="border border-border rounded-md p-3 bg-secondary/30 text-xs flex flex-wrap gap-4 items-center">
                <span>Commit: <span className="font-mono text-commit">{fmtMoney(dealTotals.commit)}</span></span>
                <span>·</span>
                <span>Promoted Upside: <span className="font-mono text-amber-500">{fmtMoney(dealTotals.promoted)}</span></span>
                <span>·</span>
                <span>Total Call: <span className="font-mono font-semibold">{fmtMoney(dealTotals.total)}</span></span>
                <span>·</span>
                <span className={callVsMgr.color}>
                  vs My Commit: <span className="font-mono">{mgrSaved ? fmtMoney(mgrAmount) : 'not set'}</span> {callVsMgr.icon}
                </span>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Snapshot history */}
          <Collapsible open={historyOpen} onOpenChange={setHistoryOpen} className="space-y-2 border-t border-border pt-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Snapshot history</h3>
                <p className="text-xs text-muted-foreground">{monthSnapshots.length} snapshot{monthSnapshots.length === 1 ? '' : 's'} for {getMonthLabel(selectedMonth)}</p>
              </div>
              <CollapsibleTrigger asChild>
                <Button size="sm" variant="outline" className="gap-1.5">
                  {historyOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  {historyOpen ? 'Hide' : 'Show'}
                </Button>
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent>
              {monthSnapshots.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No snapshots yet. Click Snapshot above to capture one.</p>
              ) : (
                <div className="space-y-1">
                  {monthSnapshots.map(s => (
                    <div key={s.id} className="flex items-center gap-2 text-xs border border-border rounded-md px-3 py-2">
                      <span className="flex-1">
                        <span className="font-medium">{fmtTs(s.createdAt)}</span>
                        <span className="text-muted-foreground"> · {fmtMoney(s.totalCall)} call · {s.deals.length} deals</span>
                        {s.reconciledAt && <span className="text-positive"> · reconciled</span>}
                      </span>
                      <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => setViewingSnapshot(s)}>
                        <Eye size={12} /> View
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { reconcileForecastSnapshot(s.id); toast({ title: 'Reconciled' }); }}>
                        Reconcile
                      </Button>
                      <button
                        onClick={() => { if (confirm('Delete this snapshot?')) deleteForecastSnapshot(s.id); }}
                        className="text-muted-foreground hover:text-negative p-1"
                        title="Delete snapshot"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>


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

      <CommissionReconciliation />
      {viewingSnapshot && (
        <ForecastSnapshotView snapshot={forecastSnapshots.find(s => s.id === viewingSnapshot.id) ?? viewingSnapshot} onClose={() => setViewingSnapshot(null)} />
      )}
    </div>
  );
}

interface RepCommitCardProps {
  repName: string;
  inactive: boolean;
  existingAmount?: number;
  existingUpdatedAt?: string;
  draft: { amount: string; notes: string };
  onChangeAmount: (v: string) => void;
  onChangeNotes: (v: string) => void;
  onSave: () => void;
  fmtMoney: (n: number) => string;
  fmtTs: (iso?: string) => string;
}

function RepCommitCard({
  repName, inactive, existingAmount, existingUpdatedAt, draft,
  onChangeAmount, onChangeNotes, onSave, fmtMoney, fmtTs,
}: RepCommitCardProps) {
  const notesRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (notesRef.current) {
      notesRef.current.style.height = 'auto';
      notesRef.current.style.height = `${notesRef.current.scrollHeight}px`;
    }
  }, [draft.notes]);

  return (
    <div className={`rounded-md border border-border p-3 space-y-2 bg-card ${inactive ? 'opacity-70' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-foreground flex items-center gap-2">
          {repName}
          {inactive && (
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-border text-muted-foreground bg-muted/40">
              Inactive
            </span>
          )}
        </span>
        {existingAmount !== undefined && (
          <span className="text-xs text-positive font-mono flex items-center gap-1">
            <Check size={12} /> {fmtMoney(existingAmount)}
          </span>
        )}
      </div>
      <div className="space-y-1">
        <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Your commit ($)</label>
        <input
          type="number"
          value={draft.amount}
          onChange={(e) => onChangeAmount(e.target.value)}
          placeholder="0"
          className="w-full bg-secondary border border-border rounded-md px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
      <div className="space-y-1">
        <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">1:1 notes</label>
        <Textarea
          ref={notesRef}
          placeholder="1:1 notes — context, commitments, concerns..."
          value={draft.notes}
          onChange={(e) => onChangeNotes(e.target.value)}
          className="min-h-[80px] resize-none overflow-hidden text-xs"
          onInput={(e) => {
            const target = e.target as HTMLTextAreaElement;
            target.style.height = 'auto';
            target.style.height = `${target.scrollHeight}px`;
          }}
        />
      </div>
      <div className="flex items-center justify-between">
        {existingUpdatedAt ? (
          <span className="text-[10px] text-muted-foreground">Saved {fmtTs(existingUpdatedAt)}</span>
        ) : <span />}
        <Button onClick={onSave} size="sm" variant="outline" className="h-7 gap-1 text-xs">
          <Check size={12} /> Save
        </Button>
      </div>
    </div>
  );
}
