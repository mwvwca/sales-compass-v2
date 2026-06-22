import { useMemo, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { buildChangelogIndex, flagDeal } from '@/lib/dealRisk';
import { normalizeRepName } from '@/lib/repUtils';
import {
  getQuarter, getMonthKey, getMonthLabel, getQuarterMonths, getCurrentQuarter,
  getISOWeekRange, getDateAtUtcStart, addDaysUTC, addMonthsUTC, getYearQuarters,
  quarterStart, quarterEnd,
  type Quarter,
} from '@/types/forecast';
import OpportunityList from './OpportunityList';
import ExecutiveReport from './ExecutiveReport';
import PipelineCoverage from './PipelineCoverage';
import SalesIntelligence from './SalesIntelligence';
import CommitAccuracySection from './CommitAccuracySection';
import CoverageTrendCard from './CoverageTrendCard';

import { Switch } from '@/components/ui/switch';
import { ChevronLeft, ChevronRight, Camera } from 'lucide-react';

type Scope = 'weekly' | 'monthly' | 'quarterly' | 'annual';

/** Parse a close-date string as a LOCAL date to avoid UTC midnight shifting
 *  the day into the prior day in negative-offset timezones. */
function parseDateLocal(dateStr: string): Date | null {
  if (!dateStr) return null;
  const iso = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
  const us = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return new Date(+us[3], +us[1] - 1, +us[2]);
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function localMonthKey(dateStr: string): string | null {
  const d = parseDateLocal(dateStr);
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function localQuarter(dateStr: string): string | null {
  const d = parseDateLocal(dateStr);
  if (!d) return null;
  const q = Math.ceil((d.getMonth() + 1) / 3);
  return `${d.getFullYear()}-Q${q}`;
}

export default function ForecastDashboard() {
  const { reps, opportunities, monthlyRepCommits, monthlyManagerCommits, managerQuotas, getManagerQuota, changelog, weeklySnapshots, captureWeeklySnapshot, dealRegistrations, snapshots } = useForecast();
  const [scope, setScope] = useState<Scope>('monthly');
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
    if (scope === 'monthly') return localMonthKey(cd) === anchorMonthKey;
    if (scope === 'quarterly') return localQuarter(cd) === anchorQuarter;
    // Annual: strict year equality on the locally-parsed close date
    const oppYear = parseDateLocal(cd)?.getFullYear();
    return oppYear === anchor.getUTCFullYear();
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
    if (scope === 'monthly') return [{ key: anchorMonthKey, label: getMonthLabel(anchorMonthKey), matches: cd => localMonthKey(cd) === anchorMonthKey }];
    if (scope === 'quarterly') {
      return getQuarterMonths(anchorQuarter).map(m => ({ key: m, label: getMonthLabel(m), matches: (cd: string) => localMonthKey(cd) === m }));
    }
    return getYearQuarters(anchor.getUTCFullYear()).map(q => ({ key: q, label: q.split('-')[1], matches: (cd: string) => localQuarter(cd) === q }));
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

  // Commit integrity: how much of the in-scope commit carries a deterministic risk flag
  // (stalled, under-qualified, repeatedly pushed, weak next step). A "commit" that is
  // also flagged is the forecast-integrity signal a manager wants surfaced.
  const commitChangelogIndex = useMemo(() => buildChangelogIndex(changelog), [changelog]);
  const commitAtRisk = useMemo(() => {
    const today = new Date();
    let amt = 0, n = 0;
    for (const o of hudOpps) {
      if (o.classification !== 'commit') continue;
      if (flagDeal(o, commitChangelogIndex, today).length > 0) { amt += o.amount; n += 1; }
    }
    return { amt, n };
  }, [hudOpps, commitChangelogIndex]);

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

  // Pace-adjusted variance: where you SHOULD be by today given linear pace through the period.
  const paceData = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let periodStart: Date;
    let periodEnd: Date;

    if (scope === 'quarterly') {
      periodStart = quarterStart(anchorQuarter);
      periodEnd = quarterEnd(anchorQuarter);
    } else if (scope === 'monthly') {
      const [y, m] = anchorMonthKey.split('-').map(Number);
      periodStart = new Date(y, m - 1, 1);
      periodEnd = new Date(y, m, 0);
    } else if (scope === 'annual') {
      const y = anchor.getUTCFullYear();
      periodStart = new Date(y, 0, 1);
      periodEnd = new Date(y, 11, 31);
    } else {
      periodStart = weekRange.start;
      periodEnd = weekRange.end;
    }

    const totalDays = Math.max(1, Math.round((periodEnd.getTime() - periodStart.getTime()) / 86400000) + 1);
    const elapsedDays = Math.min(totalDays, Math.max(0,
      Math.round((today.getTime() - periodStart.getTime()) / 86400000) + 1));
    const pctElapsed = Math.min(1, Math.max(0, elapsedDays / totalDays));
    const expectedByNow = totalGoal * pctElapsed;
    const paceVariance = totalWon - expectedByNow;
    const isPast = today > periodEnd;
    const isFuture = today < periodStart;
    return { totalDays, elapsedDays, pctElapsed, expectedByNow, paceVariance, isPast, isFuture };
  }, [scope, anchor, anchorQuarter, anchorMonthKey, weekRange, totalGoal, totalWon]);

  // Defensible coverage: qualified pipeline only (Discovery 25%+ or commit/upside) ÷ goal.
  const defensibleCoverage = useMemo(() => {
    const qualifiedStageWords = ['discovery', 'technical', 'commercial', 'purchasing'];
    const qualifiedPipeline = hudOpps.filter(o => {
      if (o.classification === 'closed_won') return false;
      const stageLower = (o.stage || '').toLowerCase().trim();
      const isQualifiedStage = qualifiedStageWords.some(w => stageLower.includes(w));
      const isQualifiedClass = o.classification === 'commit' || o.classification === 'upside';
      return isQualifiedStage || isQualifiedClass;
    }).reduce((s, o) => s + o.amount, 0);
    const coverage = totalGoal > 0 ? qualifiedPipeline / totalGoal : 0;
    return { qualifiedPipeline, coverage };
  }, [hudOpps, totalGoal]);

  // Week-over-week delta from the two most recent Friday snapshots
  const wow = useMemo(() => {
    if (weeklySnapshots.length === 0) return null;
    const sorted = [...weeklySnapshots].sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));
    if (sorted.length === 1) return { single: sorted[0], current: null, prior: null };
    const current = sorted[sorted.length - 1];
    const prior = sorted[sorted.length - 2];
    return { single: null, current, prior };
  }, [weeklySnapshots]);


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
          <button
            onClick={() => captureWeeklySnapshot()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            title="Capture a weekly snapshot of full-team quarterly metrics for week-over-week tracking"
          >
            <Camera size={12} />
            Snapshot
          </button>
        </div>
      </div>


      {/* Summary Cards */}
      <div className="space-y-2">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{scopeLabel} View</span>
        {totalGoal > 0 && (() => {
          const bestCase = totalWon + totalCommit;
          const attain = totalWon / totalGoal;
          const bestPct = bestCase / totalGoal;
          const gap = totalGoal - bestCase;
          const tone = bestPct >= 0.95 ? 'text-positive' : bestPct >= 0.8 ? 'text-upside' : 'text-negative';
          return (
            <div className="bg-card border border-border rounded-lg px-4 py-2.5">
              <p className="text-[11px] font-mono leading-relaxed">
                <span className={tone}>{fmt(totalWon)} won · {Math.round(attain * 100)}% of {fmt(totalGoal)} goal</span>
                <span className="text-muted-foreground"> · best case </span>
                <span className={tone}>{fmt(bestCase)} ({Math.round(bestPct * 100)}%)</span>
                <span className="text-muted-foreground"> with all commit · </span>
                <span className={gap > 0 ? 'text-negative' : 'text-positive'}>{gap > 0 ? `${fmt(gap)} gap after commit` : 'goal covered by commit'}</span>
              </p>
            </div>
          );
        })()}
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
          {/* Row 2: Total Pipe, Commit, Upside, Pace Variance */}
          {[
            { label: 'Total Pipe', value: fmt(totalPipe), sub: `${pct(totalPipe, totalGoal)} of goal`, color: 'text-foreground', note: undefined as string | undefined },
            { label: 'Commit', value: fmt(totalCommit), sub: `${pct(totalCommit, totalGoal)} of goal`, color: 'text-commit', note: commitAtRisk.amt > 0 ? `${fmt(commitAtRisk.amt)} at risk · ${commitAtRisk.n} flagged` : undefined },
            { label: 'Upside', value: fmt(totalUpside), sub: `${pct(totalUpside, totalGoal)} of goal`, color: 'text-upside', note: undefined },
          ].map(c => (
            <div key={c.label} className="bg-card border border-border rounded-lg p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{c.label}</p>
              <p className={`text-xl font-mono font-semibold ${c.color}`}>{c.value}</p>
              <p className={`text-xs font-mono mt-0.5 ${c.color}`}>{c.sub}</p>
              {c.note && <p className="text-[11px] font-mono mt-0.5 text-negative">{c.note}</p>}
            </div>
          ))}

          {/* Pace Variance card */}
          {(() => {
            const { paceVariance, expectedByNow, elapsedDays, totalDays, pctElapsed, isPast, isFuture } = paceData;
            const tolerance = expectedByNow * 0.1;
            let color = 'text-positive';
            if (!isPast && !isFuture) {
              if (paceVariance < -tolerance) color = 'text-negative';
              else if (paceVariance < 0) color = 'text-upside';
            } else {
              color = variance >= 0 ? 'text-positive' : 'text-negative';
            }
            const label = isPast ? 'Final Variance' : isFuture ? 'Pace Variance' : 'Pace Variance';
            const headline = isPast ? fmt(variance) : isFuture ? '—' : `${paceVariance >= 0 ? '+' : ''}${fmt(paceVariance)}`;
            const subtitle = isFuture
              ? 'Period not started'
              : isPast
              ? `Final: ${fmt(totalWon)} closed vs ${fmt(totalGoal)} goal`
              : `${paceVariance >= 0 ? '✓ Ahead of pace' : '⚠ Behind pace'} — ${fmt(totalWon)} closed vs ${fmt(expectedByNow)} expected by day ${elapsedDays} of ${totalDays}`;
            return (
              <div className="bg-card border border-border rounded-lg p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{label}</p>
                <p className={`text-xl font-mono font-semibold ${color}`}>{headline}</p>
                <p className={`text-[11px] mt-0.5 ${color}`}>{subtitle}</p>
                <p className="text-[10px] text-muted-foreground mt-1">Full {scope} goal: {fmt(totalGoal)} · {Math.round(pctElapsed * 100)}% elapsed</p>
              </div>
            );
          })()}
        </div>

        {/* Row 3: Defensible Coverage (full width strip with WoW delta) */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {(() => {
            const cov = defensibleCoverage.coverage;
            const color = cov >= 3 ? 'text-positive' : cov >= 1.5 ? 'text-upside' : 'text-negative';
            return (
              <div
                className="bg-card border border-border rounded-lg p-4"
                title="Qualified pipeline (Discovery 25%+ or commit/upside) divided by goal. Excludes pre-SQL and unqualified deals."
              >
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Defensible Coverage</p>
                <p className={`text-xl font-mono font-semibold ${color}`}>{cov.toFixed(1)}x</p>
                <p className={`text-[11px] mt-0.5 ${color}`}>{fmt(defensibleCoverage.qualifiedPipeline)} qualified vs {fmt(totalGoal)} goal</p>
              </div>
            );
          })()}

          {/* Week-over-week delta strip */}
          {wow && (
            <div className="md:col-span-3 bg-card border border-border rounded-lg p-4">
              {wow.current && wow.prior ? (
                <>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
                    Since last snapshot ({wow.prior.snapshotDate} → {wow.current.snapshotDate})
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono">
                    {[
                      { label: 'Closed Won', prev: wow.prior.closedWon, curr: wow.current.closedWon, mode: 'up-good' as const },
                      { label: 'Commit', prev: wow.prior.commitPipeline, curr: wow.current.commitPipeline, mode: 'neutral' as const },
                      { label: 'Pipeline', prev: wow.prior.totalPipeline, curr: wow.current.totalPipeline, mode: 'up-good' as const },
                      { label: 'Coverage', prev: wow.prior.defensibleCoverage, curr: wow.current.defensibleCoverage, mode: 'up-good' as const, isRatio: true },
                    ].map(row => {
                      const delta = row.curr - row.prev;
                      const up = delta > 0;
                      const arrow = delta === 0 ? '·' : up ? '↑' : '↓';
                      const color = row.mode === 'neutral'
                        ? 'text-muted-foreground'
                        : delta === 0 ? 'text-muted-foreground' : up ? 'text-positive' : 'text-negative';
                      const fmtVal = (n: number) => row.isRatio ? `${n.toFixed(1)}x` : fmt(n);
                      const fmtDelta = (n: number) => row.isRatio ? `${n >= 0 ? '+' : ''}${n.toFixed(1)}x` : `${n >= 0 ? '+' : '-'}${fmt(Math.abs(n))}`;
                      return (
                        <div key={row.label}>
                          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{row.label}</div>
                          <div className="text-foreground">{fmtVal(row.prev)} → {fmtVal(row.curr)}</div>
                          <div className={color}>{arrow} {fmtDelta(delta)}</div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : wow.single ? (
                <p className="text-xs text-muted-foreground">
                  First weekly snapshot captured {wow.single.snapshotDate} — comparison available next Friday.
                </p>
              ) : null}
            </div>
          )}
        </div>

        {/* Coverage trend over the quarter */}
        <CoverageTrendCard
          snapshots={snapshots}
          quarter={getCurrentQuarter()}
          goal={reps.reduce((s, r) => s + (r.quarterlyGoals[getCurrentQuarter()] || 0), 0)}
          selectedRep={selectedRep}
        />
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
                      <td className="px-4 py-2.5 font-medium">
                        {name}
                        {data.commit === 0 && data.goal > 0 && paceData.pctElapsed > 0.5 && (
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400 align-middle" title="No commit this period with the period more than half elapsed.">no commit</span>
                        )}
                      </td>
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
