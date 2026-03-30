import { useMemo, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { normalizeRepName } from '@/context/ForecastContext';
import { getQuarter, getMonthKey, getMonthLabel, getQuarterMonths, getCurrentQuarter, type Quarter } from '@/types/forecast';
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
        byMonth: Object.fromEntries(months.map(m => [m, { commit: 0, upside: 0, closed_won: 0, total: 0 }])),
      };
    }

    for (const opp of filteredOpps) {
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
  }, [filteredOpps, repNames, selectedRep, months]);

  const getMonthlyGoals = (goal: number, byMonth: Record<string, { closed_won: number }>) => {
    const base = goal / months.length;
    const goals: Record<string, number> = {};
    let carryOver = 0;
    for (const m of months) {
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
      <div className="grid grid-cols-6 gap-3">
        {[
          { label: 'Quarterly Goal', value: fmt(totalGoal), sub: null },
          { label: 'Total Pipe', value: fmt(Object.values(summaryByRep).reduce((s, r) => s + r.total, 0)), sub: pct(Object.values(summaryByRep).reduce((s, r) => s + r.total, 0), totalGoal), color: 'text-foreground' },
          { label: 'Closed Won', value: fmt(totalClosedWon), sub: pct(totalClosedWon, totalGoal), color: 'text-positive' },
          { label: 'Commit', value: fmt(totalCommit), sub: pct(totalCommit, totalGoal), color: 'text-commit' },
          { label: 'Upside', value: fmt(totalUpside), sub: pct(totalUpside, totalGoal), color: 'text-upside' },
          { label: 'Variance', value: fmt(totalClosedWon - totalGoal), sub: pct(totalClosedWon, totalGoal), color: totalClosedWon >= totalGoal ? 'text-positive' : 'text-negative' },
        ].map(c => (
          <div key={c.label} className="bg-card border border-border rounded-lg p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{c.label}</p>
            <p className={`text-xl font-mono font-semibold ${c.color || ''}`}>{c.value}</p>
            {c.sub && <p className={`text-xs font-mono mt-0.5 ${c.color || 'text-muted-foreground'}`}>{c.sub} of goal</p>}
          </div>
        ))}
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
                {months.map(m => (
                  <th key={m} className="text-right px-3 py-2.5 text-xs font-mono font-medium text-muted-foreground uppercase tracking-wider" colSpan={1}>
                    {getMonthLabel(m)}
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
                    {months.map(m => {
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
                {months.map(m => {
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

      {/* Opportunities */}
      <OpportunityList opportunities={filteredOpps} lostOpportunities={lostOpps} quarter={selectedQuarter === 'full-year' ? getCurrentQuarter() : selectedQuarter} />
    </div>
  );
}
