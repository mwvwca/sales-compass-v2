import { useMemo, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { normalizeRepName } from '@/lib/repUtils';
import {
  getQuarter, getMonthKey, getMonthLabel, getQuarterMonths, getCurrentQuarter,
  getISOWeekRange, getDateAtUtcStart, addDaysUTC, addMonthsUTC, getYearQuarters,
  type Quarter,
} from '@/types/forecast';
import OpportunityList from './OpportunityList';
import ExecutiveReport from './ExecutiveReport';
import ExecutiveReportVisual from './ExecutiveReportVisual';
import PipelineCoverage from './PipelineCoverage';
import SalesIntelligence from './SalesIntelligence';
import CommitAccuracySection from './CommitAccuracySection';

import { Switch } from '@/components/ui/switch';
import { ChevronLeft, ChevronRight, FileSpreadsheet } from 'lucide-react';
import { exportMonthlyPresentation, getDefaultPresentationMonth, getPresentationButtonLabel } from '@/lib/monthlyPresentationExport';

type Scope = 'weekly' | 'monthly' | 'quarterly' | 'annual';

export default function ForecastDashboard() {
  const { reps, opportunities, monthlyRepCommits, monthlyManagerCommits, managerQuotas, getManagerQuota, changelog } = useForecast();
  const presentationMonth = getDefaultPresentationMonth();
  const [scope, setScope] = useState<Scope>('quarterly');
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [selectedRep, setSelectedRep] = useState<string | 'all'>('all');
  const [showGoals, setShowGoals] = useState(false);

  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const pct = (n: number, d: number) => d === 0 ? '—' : `${Math.round((n / d) * 100)}%`;

  // Anchor-derived references
  const anchorISO = anchor.toISOString();
  const anchorQuarter: Quarter = getQuarter(anchorISO);
  const anchorMonthKey = `${anchor.getUTCFullYear()}-${String(anchor.getUTCMonth() + 1).padStart(2, '0')}`;
  const weekRange = useMemo(() => getISOWeekRange(anchor), [anchor]);

  // Scope predicate: which opps fall in the active period
  const inScope = useMemo(() => (cd: string): boolean => {
    if (!cd) return false;
    if (scope === 'weekly') {
      const d = getDateAtUtcStart(cd);
      return d >= weekRange.start && d <= weekRange.end;
    }
    if (scope === 'monthly') return getMonthKey(cd) === anchorMonthKey;
    if (scope === 'quarterly') return getQuarter(cd) === anchorQuarter;
    return getDateAtUtcStart(cd).getUTCFullYear() === anchor.getUTCFullYear();
  }, [scope, anchor, anchorMonthKey, anchorQuarter, weekRange]);

  // Quarters this scope spans (for rep goal aggregation + downstream comps)
  const scopeQuarters: Quarter[] = useMemo(() => {
    if (scope === 'annual') return getYearQuarters(anchor.getUTCFullYear());
    return [anchorQuarter];
  }, [scope, anchor, anchorQuarter]);

  const goalDivisor = scope === 'weekly' ? 13 : scope === 'monthly' ? 3 : 1;

  // Buckets shown as columns in the rep table
  type Bucket = { key: string; label: string; matches: (cd: string) => boolean };
  const buckets: Bucket[] = useMemo(() => {
    if (scope === 'weekly') return [{ key: 'w', label: weekRange.label, matches: () => true }];
    if (scope === 'monthly') return [{ key: anchorMonthKey, label: getMonthLabel(anchorMonthKey), matches: cd => getMonthKey(cd) === anchorMonthKey }];
    if (scope === 'quarterly') {
      return getQuarterMonths(anchorQuarter).map(m => ({ key: m, label: getMonthLabel(m), matches: (cd: string) => getMonthKey(cd) === m }));
    }
    return getYearQuarters(anchor.getUTCFullYear()).map(q => ({ key: q, label: q.split('-')[1], matches: (cd: string) => getQuarter(cd) === q }));
  }, [scope, anchor, anchorMonthKey, anchorQuarter, weekRange]);

  // Inactive reps are hidden ONLY from the rep breakdown table and the rep filter dropdown.
  // Every aggregate (HUD totals, goals, variance, coverage, etc.) uses the full unfiltered dataset.
  const inactiveSet = useMemo(() => new Set(reps.filter(r => r.isActive === false).map(r => r.name)), [reps]);
  const allRepNames = useMemo(() => {
    const names = new Set<string>();
    for (const o of opportunities) names.add(o.repName);
    for (const r of reps) names.add(r.name);
    return Array.from(names).sort();
  }, [opportunities, reps]);
  const repNames = useMemo(() => allRepNames.filter(n => !inactiveSet.has(n)), [allRepNames, inactiveSet]);

  const activeRepNames = repNames;
  const inactiveRepNames: string[] = [];

  const getRepGoal = (repName: string) => {
    const rep = reps.find(r => normalizeRepName(r.name) === normalizeRepName(repName));
    if (!rep) return 0;
    return scopeQuarters.reduce((sum, q) => sum + (rep.quarterlyGoals[q] || 0), 0) / goalDivisor;
  };

  // Base filter shared by list and HUD
  const baseFilter = (o: typeof opportunities[0]) => {
    if (selectedRep !== 'all' && o.repName !== selectedRep) return false;
    return true;
  };

  const listOpps = useMemo(() => {
    return opportunities.filter(o => {
      if (!o.closeDate) return false;
      if (o.classification === 'lost') return false;
      if (o.stage.toLowerCase().trim() === 'closed lost') return false;
      if (!baseFilter(o)) return false;
      return inScope(o.closeDate);
    });
  }, [opportunities, inScope, selectedRep]);

  const lostOpps = useMemo(() => {
    return opportunities.filter(o => {
      if (!o.closeDate) return false;
      if (o.classification !== 'lost' && o.stage.toLowerCase().trim() !== 'closed lost') return false;
      if (!baseFilter(o)) return false;
      return inScope(o.closeDate);
    });
  }, [opportunities, inScope, selectedRep]);

  // HUD totals (exclude omitted and rejected from totals)
  const hudOpps = useMemo(() => listOpps.filter(o => o.classification !== 'omitted' && o.classification !== 'rejected'), [listOpps]);
  const totalPipe = hudOpps.reduce((s, o) => s + o.amount, 0);
  const totalWon = hudOpps.filter(o => o.classification === 'closed_won').reduce((s, o) => s + o.amount, 0);
  const totalCommit = hudOpps.filter(o => o.classification === 'commit').reduce((s, o) => s + o.amount, 0);
  const totalUpside = hudOpps.filter(o => o.classification === 'upside').reduce((s, o) => s + o.amount, 0);

  const activeYear = anchor.getUTCFullYear();
  const managerQuotaRecord = getManagerQuota(activeYear);
  const managerQuotaProrated = useMemo(() => {
    if (!managerQuotaRecord || selectedRep !== 'all') return 0;
    const annual = managerQuotaRecord.annualAmount;
    if (scope === 'annual') return annual;
    if (scope === 'quarterly') return annual / 4;
    if (scope === 'monthly') return annual / 12;
    if (scope === 'weekly') return annual / 52;
    return 0;
  }, [managerQuotaRecord, selectedRep, scope]);

  const totalGoal = useMemo(() => {
    const activeReps = selectedRep === 'all' ? allRepNames : [selectedRep];
    const repTotal = activeReps.reduce((sum, name) => sum + getRepGoal(name), 0);
    return repTotal + managerQuotaProrated;
  }, [selectedRep, allRepNames, reps, scopeQuarters, goalDivisor, managerQuotaProrated]);

  const variance = totalWon - totalGoal;

  // Mgmt Commit: prefer manager override; fall back to rep rollup (only used in monthly scope when selectedRep === all).
  const mgmtCommit = useMemo(() => {
    const yr = anchor.getUTCFullYear();
    let monthKeys: string[] = [];
    if (scope === 'monthly' || scope === 'weekly') monthKeys = [anchorMonthKey];
    else if (scope === 'quarterly') monthKeys = getQuarterMonths(anchorQuarter);
    else monthKeys = Array.from({ length: 12 }, (_, i) => `${yr}-${String(i + 1).padStart(2, '0')}`);

    if (selectedRep === 'all') {
      const managerTotal = monthlyManagerCommits.filter(m => monthKeys.includes(m.monthKey)).reduce((s, m) => s + m.commitAmount, 0);
      if (managerTotal > 0) return { value: managerTotal, isFallback: false };
    }
    const repTotal = monthlyRepCommits.filter(m => {
      if (!monthKeys.includes(m.monthKey)) return false;
      if (selectedRep !== 'all' && m.repName !== selectedRep) return false;
      return true;
    }).reduce((s, m) => s + m.commitAmount, 0);
    if (repTotal > 0) return { value: repTotal, isFallback: true };
    return null;
  }, [scope, anchor, anchorMonthKey, anchorQuarter, monthlyRepCommits, monthlyManagerCommits, selectedRep]);
  const mgmtCommitTotal = mgmtCommit?.value ?? null;



  const goToGoals = () => {
    window.dispatchEvent(new CustomEvent('forecast:navigate-tab', { detail: 'goals' }));
  };

  // Per-rep summary, bucketed
  const summaryByRep = useMemo(() => {
    const summary: Record<string, {
      commit: number; upside: number; closed_won: number; total: number; goal: number;
      byBucket: Record<string, { commit: number; upside: number; closed_won: number; total: number }>;
    }> = {};
    const activeReps = selectedRep === 'all' ? repNames : [selectedRep];
    for (const name of activeReps) {
      summary[name] = {
        commit: 0, upside: 0, closed_won: 0, total: 0, goal: getRepGoal(name),
        byBucket: Object.fromEntries(buckets.map(b => [b.key, { commit: 0, upside: 0, closed_won: 0, total: 0 }])),
      };
    }
    for (const opp of hudOpps) {
      const s = summary[opp.repName];
      if (!s) continue;
      s.total += opp.amount;
      if (opp.classification === 'commit') s.commit += opp.amount;
      if (opp.classification === 'upside') s.upside += opp.amount;
      if (opp.classification === 'closed_won') s.closed_won += opp.amount;
      const b = buckets.find(b => b.matches(opp.closeDate));
      if (b) {
        const bb = s.byBucket[b.key];
        bb.total += opp.amount;
        if (opp.classification === 'commit') bb.commit += opp.amount;
        if (opp.classification === 'upside') bb.upside += opp.amount;
        if (opp.classification === 'closed_won') bb.closed_won += opp.amount;
      }
    }
    return summary;
  }, [hudOpps, repNames, selectedRep, buckets, reps, scopeQuarters, goalDivisor]);

  const getBucketGoals = (goal: number, byBucket: Record<string, { closed_won: number }>) => {
    if (!goal || buckets.length === 0) return null;
    const base = goal / buckets.length;
    const goals: Record<string, number> = {};
    let carryOver = 0;
    for (const b of buckets) {
      goals[b.key] = base + carryOver;
      const won = byBucket[b.key]?.closed_won || 0;
      const miss = goals[b.key] - won;
      carryOver = miss > 0 ? miss : 0;
    }
    return goals;
  };

  // Scope label + navigation
  const scopeLabel = scope === 'weekly' ? weekRange.label
    : scope === 'monthly' ? getMonthLabel(anchorMonthKey)
    : scope === 'quarterly' ? anchorQuarter
    : String(anchor.getUTCFullYear());

  const navigate = (dir: -1 | 1) => {
    if (scope === 'weekly') setAnchor(a => addDaysUTC(a, 7 * dir));
    else if (scope === 'monthly') setAnchor(a => addMonthsUTC(a, dir));
    else if (scope === 'quarterly') setAnchor(a => addMonthsUTC(a, 3 * dir));
  };

  const handleScopeChange = (next: Scope) => {
    setScope(next);
    // Re-anchor to "now" when switching so user lands on the current period
    setAnchor(new Date());
  };

  // Map scope back to legacy "Quarter | 'full-year'" for downstream components
  const legacyQuarter: Quarter | 'full-year' = scope === 'annual' ? 'full-year' : anchorQuarter;
  const legacyFullYearQuarters: Quarter[] = scope === 'annual' ? getYearQuarters(anchor.getUTCFullYear()) : [anchorQuarter];

  return (
    <div className="space-y-6">
      {/* Unified scope controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-0.5 bg-secondary rounded-md p-0.5">
          {(['weekly', 'monthly', 'quarterly', 'annual'] as const).map(s => (
            <button key={s} onClick={() => handleScopeChange(s)}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors capitalize ${s === scope ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}>
              {s}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 bg-secondary rounded-md p-0.5">
          <button
            onClick={() => navigate(-1)}
            disabled={scope === 'annual'}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-background/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            aria-label="Previous period"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="px-2 py-1 text-xs font-mono min-w-[7rem] text-center">{scopeLabel}</span>
          <button
            onClick={() => navigate(1)}
            disabled={scope === 'annual'}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-background/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            aria-label="Next period"
          >
            <ChevronRight size={14} />
          </button>
          {scope !== 'annual' && (
            <button
              onClick={() => setAnchor(new Date())}
              className="px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Today
            </button>
          )}
        </div>
        <select value={selectedRep} onChange={e => setSelectedRep(e.target.value)}
          className="bg-secondary border border-border rounded-md px-3 py-1.5 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-ring">
          <option value="all">All Reps</option>
          {activeRepNames.map(n => <option key={n} value={n}>{n}</option>)}
          {inactiveRepNames.length > 0 && (
            <optgroup label="Inactive">
              {inactiveRepNames.map(n => <option key={n} value={n}>{n}</option>)}
            </optgroup>
          )}
        </select>
        <div className="flex items-center gap-3 ml-auto">
          <ExecutiveReport quarter={anchorQuarter} selectedRep={selectedRep} />
          <ExecutiveReportVisual quarter={anchorQuarter} selectedRep={selectedRep} />
          <button
            onClick={() => exportMonthlyPresentation(presentationMonth, { reps, opportunities, monthlyRepCommits })}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            title="Download monthly management presentation"
          >
            <FileSpreadsheet size={14} />
            {getPresentationButtonLabel(presentationMonth)}
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="space-y-2">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{scopeLabel} View</span>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Row 1: AE Quota, Mgmt Commit, Stretch, Closed Won */}
          <div className="bg-card border border-border rounded-lg p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">AE Quota</p>
            <p className="text-xl font-mono font-semibold">{fmt(totalGoal)}</p>
            <p className="text-xs font-mono mt-0.5 text-muted-foreground">{managerQuotaProrated > 0 ? 'Rep quotas + manager quota' : 'Sum of rep quotas'}</p>
          </div>
          <div className="bg-card border border-border rounded-lg p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Mgmt Commit</p>
            {mgmtCommitTotal !== null ? (
              <>
                <p className="text-xl font-mono font-semibold text-commit">{fmt(mgmtCommitTotal)}</p>
                {mgmtCommit?.isFallback && (
                  <p className="text-[10px] mt-0.5 text-muted-foreground">Rep rollup — set your number in Goals.</p>
                )}
              </>
            ) : (
              <p className="text-xl font-mono font-semibold text-muted-foreground">
                Not set <button onClick={goToGoals} className="ml-1 text-[11px] underline text-primary">Set now</button>
              </p>
            )}
          </div>
          {/* Closed Won placed in row 1 to keep 4-col grid clean */}

          <div className="bg-card border border-border rounded-lg p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Closed Won</p>
            <p className="text-xl font-mono font-semibold text-positive">{fmt(totalWon)}</p>
            <p className="text-xs font-mono mt-0.5 text-positive">{pct(totalWon, totalGoal)} of goal</p>
          </div>
          {/* Row 2: Total Pipe, Commit, Upside, Variance */}
          {[
            { label: 'Total Pipe', value: fmt(totalPipe), sub: pct(totalPipe, totalGoal), color: 'text-foreground' },
            { label: 'Commit', value: fmt(totalCommit), sub: pct(totalCommit, totalGoal), color: 'text-commit' },
            { label: 'Upside', value: fmt(totalUpside), sub: pct(totalUpside, totalGoal), color: 'text-upside' },
            { label: 'Variance', value: fmt(variance), sub: pct(totalWon, totalGoal), color: variance >= 0 ? 'text-positive' : 'text-negative' },
          ].map(c => (
            <div key={c.label} className="bg-card border border-border rounded-lg p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{c.label}</p>
              <p className={`text-xl font-mono font-semibold ${c.color}`}>{c.value}</p>
              <p className={`text-xs font-mono mt-0.5 ${c.color}`}>{c.sub} of goal</p>
            </div>
          ))}
        </div>
      </div>


      {/* Pipeline Coverage */}
      <PipelineCoverage
        opportunities={hudOpps}
        allOpportunities={opportunities.filter(o => selectedRep === 'all' || o.repName === selectedRep)}
        totalGoal={totalGoal}
        selectedQuarter={legacyQuarter}
        fullYearQuarters={legacyFullYearQuarters}
      />

      {/* Forecast Table */}
      {Object.keys(summaryByRep).length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-end">
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
              <Switch checked={showGoals} onCheckedChange={setShowGoals} className="scale-75" />
              Goals
            </label>
          </div>
          <div className="border border-border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/50">
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Rep</th>
                  {buckets.map(b => (
                    <th key={b.key} className="text-right px-3 py-2.5 text-xs font-mono font-medium uppercase tracking-wider text-muted-foreground">
                      {b.label}
                    </th>
                  ))}
                  {showGoals && <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Goal</th>}
                  {showGoals && <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Variance</th>}
                </tr>
              </thead>
              <tbody>
                {Object.entries(summaryByRep).map(([name, data]) => {
                  const v = data.closed_won - data.goal;
                  const bucketGoals = getBucketGoals(data.goal, data.byBucket);
                  return (
                    <tr key={name} className="border-b border-border last:border-0 hover:bg-secondary/30 transition-colors">
                      <td className="px-4 py-2.5 font-medium">{name}</td>
                      {buckets.map(b => {
                        const bGoal = bucketGoals?.[b.key] || 0;
                        const bb = data.byBucket[b.key] || { total: 0, commit: 0, upside: 0, closed_won: 0 };
                        const hasClassified = bb.closed_won > 0 || bb.commit > 0 || bb.upside > 0;
                        return (
                          <td key={b.key} className="text-right px-3 py-2.5 font-mono text-xs">
                            {showGoals && bucketGoals && bGoal > 0 && <div className="text-muted-foreground">Goal: {fmt(bGoal)}</div>}
                            {!hasClassified && bb.total > 0 && <div className="text-foreground">Pipe: {fmt(bb.total)}</div>}
                            {bb.closed_won > 0 && <div className="text-positive">Won: {fmt(bb.closed_won)}</div>}
                            {bb.commit > 0 && <div className="text-commit">Commit: {fmt(bb.commit)}</div>}
                            {bb.upside > 0 && <div className="text-upside">Upside: {fmt(bb.upside)}</div>}
                          </td>
                        );
                      })}
                      {showGoals && <td className="text-right px-4 py-2.5 font-mono">{data.goal ? fmt(data.goal) : '—'}</td>}
                      {showGoals && (
                        <td className={`text-right px-4 py-2.5 font-mono font-semibold ${v >= 0 ? 'text-positive' : 'text-negative'}`}>
                          {data.goal ? fmt(v) : '—'}
                        </td>
                      )}
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-border bg-secondary/50 font-semibold">
                  <td className="px-4 py-3">Total</td>
                  {buckets.map(b => {
                    const bPipe = Object.values(summaryByRep).reduce((s, r) => s + (r.byBucket[b.key]?.total || 0), 0);
                    const bCommit = Object.values(summaryByRep).reduce((s, r) => s + (r.byBucket[b.key]?.commit || 0), 0);
                    const bUpside = Object.values(summaryByRep).reduce((s, r) => s + (r.byBucket[b.key]?.upside || 0), 0);
                    const bWon = Object.values(summaryByRep).reduce((s, r) => s + (r.byBucket[b.key]?.closed_won || 0), 0);
                    const hasClassified = bWon > 0 || bCommit > 0 || bUpside > 0;
                    return (
                      <td key={b.key} className="text-right px-3 py-3 font-mono text-xs">
                        {!hasClassified && bPipe > 0 && <div className="text-foreground">Pipe: {fmt(bPipe)}</div>}
                        {bWon > 0 && <div className="text-positive">Won: {fmt(bWon)}</div>}
                        {bCommit > 0 && <div className="text-commit">Commit: {fmt(bCommit)}</div>}
                        {bUpside > 0 && <div className="text-upside">Upside: {fmt(bUpside)}</div>}
                      </td>
                    );
                  })}
                  {showGoals && <td className="text-right px-4 py-3 font-mono">{fmt(totalGoal)}</td>}
                  {showGoals && (
                    <td className={`text-right px-4 py-3 font-mono ${totalWon >= totalGoal ? 'text-positive' : 'text-negative'}`}>
                      {fmt(totalWon - totalGoal)}
                    </td>
                  )}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Commit Accuracy */}
      <CommitAccuracySection opportunities={opportunities} changelog={changelog} />

      {/* Sales Intelligence */}
      <SalesIntelligence
        opportunities={[...hudOpps, ...lostOpps]}
        selectedQuarter={legacyQuarter}
        selectedRep={selectedRep}
      />

      {/* Opportunities */}
      <OpportunityList opportunities={listOpps} lostOpportunities={lostOpps} quarter={anchorQuarter} />
    </div>
  );
}
