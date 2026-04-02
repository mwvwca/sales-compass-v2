import { useMemo, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { normalizeRepName } from '@/context/ForecastContext';
import { getQuarter, getMonthKey, getMonthLabel, getQuarterMonths, getCurrentQuarter, getWeeksInMonth, type Quarter } from '@/types/forecast';
import OpportunityList from './OpportunityList';
import ExecutiveReport from './ExecutiveReport';
import ExecutiveReportVisual from './ExecutiveReportVisual';
import PipelineCoverage from './PipelineCoverage';
import SalesIntelligence from './SalesIntelligence';
import { Switch } from '@/components/ui/switch';

export default function ForecastDashboard() {
  const { reps, opportunities } = useForecast();
  const [selectedQuarter, setSelectedQuarter] = useState<Quarter | 'full-year'>(getCurrentQuarter());
  const [selectedRep, setSelectedRep] = useState<string | 'all'>('all');
  const [showGoals, setShowGoals] = useState(false);
  const [hudView, setHudView] = useState<'monthly' | 'quarterly' | 'annual'>('quarterly');
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);

  const quarters = useMemo(() => {
    const set = new Set<string>();
    reps.forEach(r => Object.keys(r.quarterlyGoals).forEach(q => set.add(q)));
    opportunities.forEach(o => { if (o.closeDate) set.add(getQuarter(o.closeDate)); });
    if (set.size === 0) set.add(getCurrentQuarter());
    return Array.from(set).sort() as Quarter[];
  }, [reps, opportunities]);

  const fullYearQuarters = useMemo(() => {
    if (selectedQuarter === 'full-year') {
      const year = new Date().getFullYear();
      return [`${year}-Q1`, `${year}-Q2`, `${year}-Q3`, `${year}-Q4`] as Quarter[];
    }
    return [selectedQuarter];
  }, [selectedQuarter]);

  const months = useMemo(() => fullYearQuarters.flatMap(q => getQuarterMonths(q)), [fullYearQuarters]);

  // Compute active month key for filtering (same logic as hudMetrics, but available earlier)
  const activeMonthKey = useMemo(() => {
    const now = new Date();
    const currentQ = getCurrentQuarter();
    const activeQ = selectedQuarter === 'full-year' ? currentQ : selectedQuarter;
    const activeQMonths = getQuarterMonths(activeQ);
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return selectedMonth && activeQMonths.includes(selectedMonth) ? selectedMonth : (activeQMonths.includes(currentMonthKey) ? currentMonthKey : activeQMonths[0]);
  }, [selectedQuarter, selectedMonth]);

  const activeWeekRanges = useMemo(() => getWeeksInMonth(activeMonthKey), [activeMonthKey]);

  const displayMonths = useMemo(() => {
    if (hudView === 'monthly') return [activeMonthKey];
    return months;
  }, [hudView, activeMonthKey, months]);


  const filteredOpps = useMemo(() => {
    return opportunities.filter(o => {
      if (!o.closeDate) return false;
      if (o.classification === 'lost') return false;
      if (o.stage.toLowerCase().trim() === 'closed lost') return false;
      const q = getQuarter(o.closeDate);
      if (!fullYearQuarters.includes(q)) return false;
      if (selectedRep !== 'all' && o.repName !== selectedRep) return false;
      return true;
    });
  }, [opportunities, fullYearQuarters, selectedRep]);

  // Narrowed opps for opportunity list when monthly/weekly HUD is active
  const hudFilteredOpps = useMemo(() => {
    if (hudView !== 'monthly') return filteredOpps;
    return filteredOpps.filter(o => {
      if (getMonthKey(o.closeDate) !== activeMonthKey) return false;
      if (selectedWeek !== null && activeWeekRanges[selectedWeek]) {
        const week = activeWeekRanges[selectedWeek];
        const d = new Date(o.closeDate);
        if (d < week.start || d > week.end) return false;
      }
      return true;
    });
  }, [filteredOpps, hudView, activeMonthKey, selectedWeek, activeWeekRanges]);

  const repViewOpps = useMemo(() => {
    if (hudView !== 'monthly') return filteredOpps;
    return hudFilteredOpps;
  }, [filteredOpps, hudFilteredOpps, hudView]);

  const lostOpps = useMemo(() => {
    return opportunities.filter(o => {
      if (!o.closeDate) return false;
      if (o.classification !== 'lost' && o.stage.toLowerCase().trim() !== 'closed lost') return false;
      const q = getQuarter(o.closeDate);
      if (!fullYearQuarters.includes(q)) return false;
      if (selectedRep !== 'all' && o.repName !== selectedRep) return false;
      return true;
    });
  }, [opportunities, fullYearQuarters, selectedRep]);

  const repNames = useMemo(() => {
    const names = new Set(opportunities.map(o => o.repName));
    reps.forEach(r => names.add(r.name));
    return Array.from(names).sort();
  }, [opportunities, reps]);

  const getRepGoal = (repName: string) => {
    // Case-insensitive rep matching for goals
    const rep = reps.find(r => normalizeRepName(r.name) === normalizeRepName(repName));
    if (!rep) return 0;
    return fullYearQuarters.reduce((sum, q) => sum + (rep.quarterlyGoals[q] || 0), 0);
  };

  const summaryByRep = useMemo(() => {
    const summary: Record<string, { commit: number; upside: number; closed_won: number; total: number; goal: number; byMonth: Record<string, { commit: number; upside: number; closed_won: number; total: number }> }> = {};
    const activeReps = selectedRep === 'all' ? repNames : [selectedRep];

    for (const name of activeReps) {
      summary[name] = {
        commit: 0, upside: 0, closed_won: 0, total: 0, goal: getRepGoal(name),
        byMonth: Object.fromEntries(displayMonths.map(m => [m, { commit: 0, upside: 0, closed_won: 0, total: 0 }])),
      };
    }

    for (const opp of repViewOpps) {
      if (opp.classification === 'omitted') continue;
      const name = opp.repName;
      if (!summary[name]) continue;
      const monthKey = getMonthKey(opp.closeDate);
      summary[name].total += opp.amount;
      if (opp.classification === 'commit') summary[name].commit += opp.amount;
      if (opp.classification === 'upside') summary[name].upside += opp.amount;
      if (opp.classification === 'closed_won') summary[name].closed_won += opp.amount;
      if (summary[name].byMonth[monthKey]) {
        summary[name].byMonth[monthKey].total += opp.amount;
        if (opp.classification === 'commit') summary[name].byMonth[monthKey].commit += opp.amount;
        if (opp.classification === 'upside') summary[name].byMonth[monthKey].upside += opp.amount;
        if (opp.classification === 'closed_won') summary[name].byMonth[monthKey].closed_won += opp.amount;
      }
    }
    return summary;
  }, [repViewOpps, repNames, selectedRep, displayMonths]);

  const getMonthlyGoals = (goal: number, byMonth: Record<string, { closed_won: number }>) => {
    const base = goal / displayMonths.length;
    const goals: Record<string, number> = {};
    let carryOver = 0;
    for (const m of displayMonths) {
      goals[m] = base + carryOver;
      const won = byMonth[m]?.closed_won || 0;
      const miss = goals[m] - won;
      carryOver = miss > 0 ? miss : 0;
    }
    return goals;
  };

  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const pct = (n: number, d: number) => d === 0 ? '—' : `${Math.round((n / d) * 100)}%`;

  const totalCommit = Object.values(summaryByRep).reduce((s, r) => s + r.commit, 0);
  const totalUpside = Object.values(summaryByRep).reduce((s, r) => s + r.upside, 0);
  const totalClosedWon = Object.values(summaryByRep).reduce((s, r) => s + r.closed_won, 0);
  const totalGoal = Object.values(summaryByRep).reduce((s, r) => s + r.goal, 0);

  // HUD scoped metrics
  const hudMetrics = useMemo(() => {
    const now = new Date();
    const currentQ = getCurrentQuarter();
    const activeQ = selectedQuarter === 'full-year' ? currentQ : selectedQuarter;
    const year = activeQ.split('-Q')[0];
    const annualQuarters = [`${year}-Q1`, `${year}-Q2`, `${year}-Q3`, `${year}-Q4`] as Quarter[];

    // For monthly, use selectedMonth if set, otherwise current month or first month of quarter
    const activeQMonths = getQuarterMonths(activeQ);
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthlyKey = selectedMonth && activeQMonths.includes(selectedMonth) ? selectedMonth : (activeQMonths.includes(currentMonthKey) ? currentMonthKey : activeQMonths[0]);

    const calcForOpps = (opps: typeof opportunities, goalAmount: number) => {
      const pipe = opps.filter(o => o.classification !== 'omitted').reduce((s, o) => s + o.amount, 0);
      const won = opps.filter(o => o.classification === 'closed_won').reduce((s, o) => s + o.amount, 0);
      const commit = opps.filter(o => o.classification === 'commit').reduce((s, o) => s + o.amount, 0);
      const upside = opps.filter(o => o.classification === 'upside').reduce((s, o) => s + o.amount, 0);
      return { pipe, won, commit, upside, goal: goalAmount, variance: won - goalAmount };
    };

    const getGoalForQuarters = (qs: Quarter[]) => {
      const activeReps = selectedRep === 'all' ? repNames : [selectedRep];
      return activeReps.reduce((sum, name) => {
        const rep = reps.find(r => normalizeRepName(r.name) === normalizeRepName(name));
        if (!rep) return sum;
        return sum + qs.reduce((s, q) => s + (rep.quarterlyGoals[q] || 0), 0);
      }, 0);
    };

    const baseFilter = (o: typeof opportunities[0]) => {
      if (!o.closeDate) return false;
      if (o.classification === 'lost' || o.stage.toLowerCase().trim() === 'closed lost') return false;
      if (selectedRep !== 'all' && o.repName !== selectedRep) return false;
      return true;
    };

    // Monthly: scoped to the selected quarter's relevant month
    const monthlyOpps = opportunities.filter(o => baseFilter(o) && getMonthKey(o.closeDate) === monthlyKey);
    const monthlyGoal = getGoalForQuarters([activeQ]) / 3;

    // Weekly: filter within the month if a week is selected
    const weeksInMonth = getWeeksInMonth(monthlyKey);
    let displayOpps = monthlyOpps;
    let displayGoal = monthlyGoal;
    if (selectedWeek !== null && weeksInMonth[selectedWeek]) {
      const week = weeksInMonth[selectedWeek];
      displayOpps = monthlyOpps.filter(o => {
        const d = new Date(o.closeDate);
        return d >= week.start && d <= week.end;
      });
      displayGoal = monthlyGoal / weeksInMonth.length;
    }
    const monthly = calcForOpps(displayOpps, displayGoal);

    // Quarterly: use selected quarter, not always current
    const quarterlyOpps = opportunities.filter(o => baseFilter(o) && getQuarter(o.closeDate) === activeQ);
    const quarterly = calcForOpps(quarterlyOpps, getGoalForQuarters([activeQ]));

    // Annual: full year
    const annualOpps = opportunities.filter(o => baseFilter(o) && annualQuarters.includes(getQuarter(o.closeDate)));
    const annual = calcForOpps(annualOpps, getGoalForQuarters(annualQuarters));

    return { monthly, quarterly, annual, monthlyKey, activeQMonths, weeksInMonth };
  }, [opportunities, reps, repNames, selectedRep, selectedQuarter, selectedMonth, selectedWeek]);

  const activeHud = hudMetrics[hudView];
  const hudLabel = hudView === 'monthly'
    ? (selectedWeek !== null && hudMetrics.weeksInMonth[selectedWeek]
      ? `${getMonthLabel(hudMetrics.monthlyKey)} ${hudMetrics.weeksInMonth[selectedWeek].label}`
      : getMonthLabel(hudMetrics.monthlyKey))
    : hudView === 'quarterly' ? 'Quarterly' : 'Annual';

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex items-center gap-3">
        <div className="flex gap-1 bg-secondary rounded-md p-0.5">
          {quarters.map(q => (
            <button key={q} onClick={() => setSelectedQuarter(q)}
              className={`px-3 py-1.5 text-xs font-mono rounded transition-colors ${q === selectedQuarter ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}>
              {q}
            </button>
          ))}
          <button onClick={() => setSelectedQuarter('full-year')}
            className={`px-3 py-1.5 text-xs font-mono rounded transition-colors ${selectedQuarter === 'full-year' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}>
            Full Year
          </button>
        </div>
        <select value={selectedRep} onChange={e => setSelectedRep(e.target.value)}
          className="bg-secondary border border-border rounded-md px-3 py-1.5 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-ring">
          <option value="all">All Reps</option>
          {repNames.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <div className="flex items-center gap-3 ml-auto">
          <ExecutiveReport quarter={selectedQuarter === 'full-year' ? getCurrentQuarter() : selectedQuarter} selectedRep={selectedRep} />
          <ExecutiveReportVisual quarter={selectedQuarter === 'full-year' ? getCurrentQuarter() : selectedQuarter} selectedRep={selectedRep} />
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <Switch checked={showGoals} onCheckedChange={setShowGoals} className="scale-75" />
            Goals
          </label>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="flex bg-secondary rounded-md p-0.5">
            {(['monthly', 'quarterly', 'annual'] as const).map(v => (
              <button key={v} onClick={() => setHudView(v)}
                className={`px-2 py-1 text-[10px] font-mono rounded transition-colors ${v === hudView ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}>
                {v === 'monthly' ? 'M' : v === 'quarterly' ? 'Q' : 'Y'}
              </button>
            ))}
          </div>
          {hudView === 'monthly' && (
            <>
              <div className="flex bg-secondary rounded-md p-0.5">
                {hudMetrics.activeQMonths.map(m => (
                  <button key={m} onClick={() => { setSelectedMonth(m); setSelectedWeek(null); }}
                    className={`px-2 py-1 text-[10px] font-mono rounded transition-colors ${m === hudMetrics.monthlyKey ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}>
                    {getMonthLabel(m)}
                  </button>
                ))}
              </div>
              <div className="flex bg-secondary rounded-md p-0.5">
                <button onClick={() => setSelectedWeek(null)}
                  className={`px-2 py-1 text-[10px] font-mono rounded transition-colors ${selectedWeek === null ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}>
                  All
                </button>
                {hudMetrics.weeksInMonth.map((w, i) => (
                  <button key={i} onClick={() => setSelectedWeek(i)}
                    className={`px-2 py-1 text-[10px] font-mono rounded transition-colors ${selectedWeek === i ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}>
                    {w.label}
                  </button>
                ))}
              </div>
            </>
          )}
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{hudLabel} View</span>
        </div>
        <div className="grid grid-cols-6 gap-3">
          {[
            { label: `${hudLabel} Goal`, value: fmt(activeHud.goal), sub: null },
            { label: 'Total Pipe', value: fmt(activeHud.pipe), sub: pct(activeHud.pipe, activeHud.goal), color: 'text-foreground' },
            { label: 'Closed Won', value: fmt(activeHud.won), sub: pct(activeHud.won, activeHud.goal), color: 'text-positive' },
            { label: 'Commit', value: fmt(activeHud.commit), sub: pct(activeHud.commit, activeHud.goal), color: 'text-commit' },
            { label: 'Upside', value: fmt(activeHud.upside), sub: pct(activeHud.upside, activeHud.goal), color: 'text-upside' },
            { label: 'Variance', value: fmt(activeHud.variance), sub: pct(activeHud.won, activeHud.goal), color: activeHud.variance >= 0 ? 'text-positive' : 'text-negative' },
          ].map(c => (
            <div key={c.label} className="bg-card border border-border rounded-lg p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{c.label}</p>
              <p className={`text-xl font-mono font-semibold ${c.color || ''}`}>{c.value}</p>
              {c.sub && <p className={`text-xs font-mono mt-0.5 ${c.color || 'text-muted-foreground'}`}>{c.sub} of goal</p>}
            </div>
          ))}
        </div>
      </div>

      {/* Pipeline Coverage */}
      <PipelineCoverage
        opportunities={filteredOpps}
        allOpportunities={opportunities.filter(o => selectedRep === 'all' || o.repName === selectedRep)}
        totalGoal={totalGoal}
        selectedQuarter={selectedQuarter}
        fullYearQuarters={fullYearQuarters}
      />

      {/* Forecast Table */}
      {Object.keys(summaryByRep).length > 0 && (
        <div className="border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Rep</th>
                {displayMonths.map(m => (
                  <th key={m} className="text-right px-3 py-2.5 text-xs font-mono font-medium text-muted-foreground uppercase tracking-wider" colSpan={1}>
                    {hudView === 'monthly' && selectedWeek !== null && activeWeekRanges[selectedWeek]
                      ? `${getMonthLabel(m)} ${activeWeekRanges[selectedWeek].label}`
                      : getMonthLabel(m)}
                  </th>
                ))}
                {showGoals && <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Goal</th>}
                {showGoals && <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Variance</th>}
              </tr>
            </thead>
            <tbody>
              {Object.entries(summaryByRep).map(([name, data]) => {
                const variance = data.closed_won - data.goal;
                const monthlyGoals = data.goal ? getMonthlyGoals(data.goal, data.byMonth) : null;
                return (
                  <tr key={name} className="border-b border-border last:border-0 hover:bg-secondary/30 transition-colors">
                    <td className="px-4 py-2.5 font-medium">{name}</td>
                    {displayMonths.map(m => {
                      const mGoal = monthlyGoals?.[m] || 0;
                      const mWon = data.byMonth[m]?.closed_won || 0;
                      const mCommit = data.byMonth[m]?.commit || 0;
                      const mUpside = data.byMonth[m]?.upside || 0;
                      return (
                        <td key={m} className="text-right px-3 py-2.5 font-mono text-xs">
                          {showGoals && monthlyGoals && mGoal > 0 && <div className="text-muted-foreground">Goal: {fmt(mGoal)}</div>}
                          {mWon > 0 && <div className="text-positive">Won: {fmt(mWon)}</div>}
                          {mCommit > 0 && <div className="text-commit">Commit: {fmt(mCommit)}</div>}
                          {mUpside > 0 && <div className="text-upside">Upside: {fmt(mUpside)}</div>}
                        </td>
                      );
                    })}
                    {showGoals && <td className="text-right px-4 py-2.5 font-mono">{data.goal ? fmt(data.goal) : '—'}</td>}
                    {showGoals && (
                      <td className={`text-right px-4 py-2.5 font-mono font-semibold ${variance >= 0 ? 'text-positive' : 'text-negative'}`}>
                        {data.goal ? fmt(variance) : '—'}
                      </td>
                    )}
                  </tr>
                );
              })}
              <tr className="border-t-2 border-border bg-secondary/50 font-semibold">
                <td className="px-4 py-3">Total</td>
                {displayMonths.map(m => {
                  const mCommit = Object.values(summaryByRep).reduce((s, r) => s + (r.byMonth[m]?.commit || 0), 0);
                  const mUpside = Object.values(summaryByRep).reduce((s, r) => s + (r.byMonth[m]?.upside || 0), 0);
                  const mWon = Object.values(summaryByRep).reduce((s, r) => s + (r.byMonth[m]?.closed_won || 0), 0);
                  return (
                    <td key={m} className="text-right px-3 py-3 font-mono text-xs">
                      {mWon > 0 && <div className="text-positive">Won: {fmt(mWon)}</div>}
                      {mCommit > 0 && <div className="text-commit">Commit: {fmt(mCommit)}</div>}
                      {mUpside > 0 && <div className="text-upside">Upside: {fmt(mUpside)}</div>}
                    </td>
                  );
                })}
                {showGoals && <td className="text-right px-4 py-3 font-mono">{fmt(totalGoal)}</td>}
                {showGoals && (
                  <td className={`text-right px-4 py-3 font-mono ${totalClosedWon >= totalGoal ? 'text-positive' : 'text-negative'}`}>
                    {fmt(totalClosedWon - totalGoal)}
                  </td>
                )}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Sales Intelligence */}
      <SalesIntelligence
        opportunities={[...hudFilteredOpps, ...lostOpps]}
        selectedQuarter={selectedQuarter}
        selectedRep={selectedRep}
      />

      {/* Opportunities */}
      <OpportunityList opportunities={hudFilteredOpps} lostOpportunities={lostOpps} quarter={selectedQuarter === 'full-year' ? getCurrentQuarter() : selectedQuarter} />
    </div>
  );
}
