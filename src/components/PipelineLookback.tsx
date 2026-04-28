import { useMemo, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import type { Opportunity, OpportunitySnapshot } from '@/types/forecast';
import { getQuarter, getCurrentQuarter, type Quarter } from '@/types/forecast';
import { format } from 'date-fns';
import { CalendarIcon, TrendingUp, TrendingDown, Plus, Minus, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const pct = (n: number, d: number) => d === 0 ? '—' : `${Math.round((n / d) * 100)}%`;

type HistoricalState = {
  amount: number;
  closeDate: string;
  stage: string;
  classification: string;
  name: string;
  repName: string;
  source: 'snapshot' | 'current';
  asOfDate: string; // the actual date of the snapshot used
};

function getStateAsOf(
  opp: Opportunity,
  snapshots: OpportunitySnapshot[],
  asOfMs: number
): HistoricalState | null {
  // Find latest snapshot on or before asOf
  const eligible = snapshots
    .filter(s => s.opportunityId === opp.id && new Date(s.importDate).getTime() <= asOfMs)
    .sort((a, b) => new Date(b.importDate).getTime() - new Date(a.importDate).getTime());

  if (eligible.length > 0) {
    const s = eligible[0];
    return {
      amount: s.amount,
      closeDate: s.closeDate,
      stage: s.stage,
      classification: s.classification,
      name: s.name,
      repName: s.repName,
      source: 'snapshot',
      asOfDate: s.importDate,
    };
  }
  // No snapshot before asOf — opp didn't exist yet at that point
  return null;
}

const includeInPipe = (cls: string) => cls !== 'omitted' && cls !== 'lost';

export default function PipelineLookback() {
  const { opportunities, snapshots, reps } = useForecast();
  const today = new Date();
  const defaultAsOf = new Date(today.getFullYear(), today.getMonth(), 1); // first of current month
  const [asOfDate, setAsOfDate] = useState<Date>(defaultAsOf);
  const [selectedQuarter, setSelectedQuarter] = useState<Quarter | 'all'>(getCurrentQuarter());
  const [selectedRep, setSelectedRep] = useState<string>('all');

  const repNames = useMemo(() => {
    const names = new Set(opportunities.map(o => o.repName));
    reps.forEach(r => names.add(r.name));
    return Array.from(names).sort();
  }, [opportunities, reps]);

  const quarters = useMemo(() => {
    const set = new Set<string>();
    opportunities.forEach(o => { if (o.closeDate) set.add(getQuarter(o.closeDate)); });
    if (set.size === 0) set.add(getCurrentQuarter());
    return Array.from(set).sort() as Quarter[];
  }, [opportunities]);

  const asOfMs = useMemo(() => {
    // End of selected day
    const d = new Date(asOfDate);
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }, [asOfDate]);

  const analysis = useMemo(() => {
    const filterByScope = (closeDate: string, repName: string) => {
      if (selectedRep !== 'all' && repName !== selectedRep) return false;
      if (selectedQuarter !== 'all') {
        if (!closeDate || getQuarter(closeDate) !== selectedQuarter) return false;
      }
      return true;
    };

    const rows: Array<{
      id: string;
      name: string;
      repName: string;
      type: 'new' | 'removed' | 'changed' | 'unchanged';
      past: HistoricalState | null;
      current: Opportunity | null;
      changes: string[];
    }> = [];

    const oppById = new Map(opportunities.map(o => [o.id, o]));

    // All opportunity IDs we know about (current + historical via snapshots)
    const allIds = new Set<string>();
    opportunities.forEach(o => allIds.add(o.id));
    snapshots.forEach(s => allIds.add(s.opportunityId));

    for (const id of allIds) {
      const current = oppById.get(id) || null;
      // build a stub-opp for past lookups when current is gone
      const refOpp: Opportunity | null = current || (() => {
        const s = snapshots.filter(x => x.opportunityId === id).sort((a, b) =>
          new Date(b.importDate).getTime() - new Date(a.importDate).getTime())[0];
        if (!s) return null;
        return {
          id, name: s.name, repId: '', repName: s.repName, amount: s.amount,
          closeDate: s.closeDate, stage: s.stage,
          classification: s.classification as Opportunity['classification'],
          probability: 0, importDate: s.importDate,
        };
      })();

      if (!refOpp) continue;
      if (!filterByScope(current?.closeDate || refOpp.closeDate, current?.repName || refOpp.repName)) continue;

      const past = getStateAsOf(refOpp, snapshots, asOfMs);

      if (!past && !current) continue;

      if (!past && current) {
        // Brand new since asOf
        if (!includeInPipe(current.classification)) continue;
        rows.push({
          id, name: current.name, repName: current.repName,
          type: 'new', past: null, current, changes: ['New opportunity'],
        });
        continue;
      }

      if (past && !current) {
        // Removed
        rows.push({
          id, name: past.name, repName: past.repName,
          type: 'removed', past, current: null, changes: ['Removed from pipeline'],
        });
        continue;
      }

      if (past && current) {
        const changes: string[] = [];
        if (Math.abs(past.amount - current.amount) > 0.01) {
          const delta = current.amount - past.amount;
          changes.push(`Amount ${delta > 0 ? '+' : ''}${fmt(delta)}`);
        }
        if (past.closeDate !== current.closeDate) {
          changes.push(`Close ${past.closeDate} → ${current.closeDate}`);
        }
        if (past.stage !== current.stage) {
          changes.push(`Stage: ${past.stage} → ${current.stage}`);
        }
        if (past.classification !== current.classification) {
          changes.push(`Class: ${past.classification} → ${current.classification}`);
        }
        rows.push({
          id, name: current.name, repName: current.repName,
          type: changes.length ? 'changed' : 'unchanged',
          past, current, changes,
        });
      }
    }

    // Snapshot totals (as-of)
    const pastTotals = { pipe: 0, commit: 0, upside: 0, won: 0, count: 0 };
    const currentTotals = { pipe: 0, commit: 0, upside: 0, won: 0, count: 0 };

    for (const row of rows) {
      if (row.past && includeInPipe(row.past.classification)) {
        pastTotals.pipe += row.past.amount;
        pastTotals.count++;
        if (row.past.classification === 'commit') pastTotals.commit += row.past.amount;
        if (row.past.classification === 'upside') pastTotals.upside += row.past.amount;
        if (row.past.classification === 'closed_won') pastTotals.won += row.past.amount;
      }
      if (row.current && includeInPipe(row.current.classification)) {
        currentTotals.pipe += row.current.amount;
        currentTotals.count++;
        if (row.current.classification === 'commit') currentTotals.commit += row.current.amount;
        if (row.current.classification === 'upside') currentTotals.upside += row.current.amount;
        if (row.current.classification === 'closed_won') currentTotals.won += row.current.amount;
      }
    }

    return { rows, pastTotals, currentTotals };
  }, [opportunities, snapshots, asOfMs, selectedQuarter, selectedRep]);

  const movementRows = useMemo(
    () => analysis.rows.filter(r => r.type !== 'unchanged').sort((a, b) => {
      const order = { new: 0, changed: 1, removed: 2, unchanged: 3 };
      return order[a.type] - order[b.type];
    }),
    [analysis.rows]
  );

  // Commit-specific outcomes: deals that were Commit as of the lookback date
  const commitOutcomes = useMemo(() => {
    type Outcome = 'won' | 'lost' | 'pushed' | 'amount_changed' | 'still_commit' | 'downgraded' | 'removed';
    const items: Array<{
      id: string; name: string; repName: string;
      pastAmount: number; currentAmount: number;
      pastCloseDate: string; currentCloseDate: string | null;
      currentClass: string | null;
      outcome: Outcome; detail: string;
    }> = [];

    const monthOf = (d: string) => d ? d.slice(0, 7) : '';

    for (const row of analysis.rows) {
      if (!row.past || row.past.classification !== 'commit') continue;
      const pAmt = row.past.amount;
      const cur = row.current;
      let outcome: Outcome;
      let detail = '';

      if (!cur) {
        outcome = 'removed';
        detail = 'No longer in pipeline';
      } else if (cur.classification === 'closed_won') {
        outcome = 'won';
        detail = `Won ${fmt(cur.amount)}${Math.abs(cur.amount - pAmt) > 0.5 ? ` (was ${fmt(pAmt)})` : ''}`;
      } else if (cur.classification === 'lost' || cur.stage.toLowerCase().trim() === 'closed lost') {
        outcome = 'lost';
        detail = 'Marked Closed Lost';
      } else if (monthOf(row.past.closeDate) !== monthOf(cur.closeDate)) {
        outcome = 'pushed';
        detail = `Close date ${row.past.closeDate} → ${cur.closeDate}`;
      } else if (cur.classification !== 'commit') {
        outcome = 'downgraded';
        detail = `Reclassified to ${cur.classification}`;
      } else if (Math.abs(cur.amount - pAmt) > 0.5) {
        outcome = 'amount_changed';
        const delta = cur.amount - pAmt;
        detail = `Amount ${delta > 0 ? '+' : ''}${fmt(delta)} (${fmt(pAmt)} → ${fmt(cur.amount)})`;
      } else {
        outcome = 'still_commit';
        detail = 'Unchanged on commit';
      }

      items.push({
        id: row.id, name: row.name, repName: row.repName,
        pastAmount: pAmt, currentAmount: cur?.amount ?? 0,
        pastCloseDate: row.past.closeDate, currentCloseDate: cur?.closeDate ?? null,
        currentClass: cur?.classification ?? null,
        outcome, detail,
      });
    }

    const order: Record<Outcome, number> = { won: 0, lost: 1, pushed: 2, downgraded: 3, removed: 4, amount_changed: 5, still_commit: 6 };
    items.sort((a, b) => order[a.outcome] - order[b.outcome]);

    const totals = {
      startingCommit: items.reduce((s, i) => s + i.pastAmount, 0),
      won: items.filter(i => i.outcome === 'won').reduce((s, i) => s + i.currentAmount, 0),
      lost: items.filter(i => i.outcome === 'lost').reduce((s, i) => s + i.pastAmount, 0),
      pushed: items.filter(i => i.outcome === 'pushed').reduce((s, i) => s + i.pastAmount, 0),
      downgraded: items.filter(i => i.outcome === 'downgraded').reduce((s, i) => s + i.pastAmount, 0),
      removed: items.filter(i => i.outcome === 'removed').reduce((s, i) => s + i.pastAmount, 0),
      stillCommit: items.filter(i => i.outcome === 'still_commit' || i.outcome === 'amount_changed').reduce((s, i) => s + i.currentAmount, 0),
      count: items.length,
    };
    return { items, totals };
  }, [analysis.rows]);

  const snapshotCoverage = useMemo(() => {
    const withSnap = analysis.rows.filter(r => r.past?.source === 'snapshot').length;
    return { withSnap, total: analysis.rows.length };
  }, [analysis.rows]);

  const Delta = ({ past, current }: { past: number; current: number }) => {
    const d = current - past;
    if (Math.abs(d) < 0.5) return <span className="text-muted-foreground text-xs">—</span>;
    return (
      <span className={`text-xs font-mono ${d > 0 ? 'text-positive' : 'text-negative'}`}>
        {d > 0 ? '+' : ''}{fmt(d)}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn('justify-start text-left font-mono text-xs', !asOfDate && 'text-muted-foreground')}
            >
              <CalendarIcon className="mr-2 h-3.5 w-3.5" />
              As of {format(asOfDate, 'PPP')}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={asOfDate}
              onSelect={d => d && setAsOfDate(d)}
              disabled={d => d > new Date()}
              initialFocus
              className={cn('p-3 pointer-events-auto')}
            />
          </PopoverContent>
        </Popover>

        <div className="flex gap-1 bg-secondary rounded-md p-0.5">
          {quarters.map(q => (
            <button
              key={q}
              onClick={() => setSelectedQuarter(q)}
              className={`px-3 py-1.5 text-xs font-mono rounded transition-colors ${
                q === selectedQuarter ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {q}
            </button>
          ))}
          <button
            onClick={() => setSelectedQuarter('all')}
            className={`px-3 py-1.5 text-xs font-mono rounded transition-colors ${
              selectedQuarter === 'all' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            All
          </button>
        </div>

        <select
          value={selectedRep}
          onChange={e => setSelectedRep(e.target.value)}
          className="bg-secondary border border-border rounded-md px-3 py-1.5 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="all">All Reps</option>
          {repNames.map(n => <option key={n} value={n}>{n}</option>)}
        </select>

        <span className="text-[10px] text-muted-foreground ml-auto">
          {snapshotCoverage.withSnap} / {snapshotCoverage.total} opps have snapshot coverage at this date
        </span>
      </div>

      {/* Snapshot comparison */}
      <div>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          Pipeline snapshot comparison
        </h3>
        <div className="grid grid-cols-5 gap-3">
          {[
            { label: 'Total Pipe', past: analysis.pastTotals.pipe, current: analysis.currentTotals.pipe, color: 'text-foreground' },
            { label: 'Closed Won', past: analysis.pastTotals.won, current: analysis.currentTotals.won, color: 'text-positive' },
            { label: 'Commit', past: analysis.pastTotals.commit, current: analysis.currentTotals.commit, color: 'text-commit' },
            { label: 'Upside', past: analysis.pastTotals.upside, current: analysis.currentTotals.upside, color: 'text-upside' },
            { label: 'Open Deals', past: analysis.pastTotals.count, current: analysis.currentTotals.count, color: 'text-foreground', isCount: true },
          ].map(c => (
            <div key={c.label} className="bg-card border border-border rounded-lg p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{c.label}</p>
              <div className="flex items-baseline gap-2">
                <p className={`text-base font-mono ${c.color}`}>
                  {c.isCount ? c.past : fmt(c.past)}
                </p>
                <ArrowRight size={10} className="text-muted-foreground" />
                <p className={`text-lg font-mono font-semibold ${c.color}`}>
                  {c.isCount ? c.current : fmt(c.current)}
                </p>
              </div>
              {!c.isCount && (
                <div className="mt-1">
                  <Delta past={c.past} current={c.current} />
                </div>
              )}
              {c.isCount && (
                <p className={`text-xs font-mono mt-0.5 ${c.current - c.past > 0 ? 'text-positive' : c.current - c.past < 0 ? 'text-negative' : 'text-muted-foreground'}`}>
                  {c.current - c.past > 0 ? '+' : ''}{c.current - c.past}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Commit outcomes */}
      <div>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          Commit outcomes since {format(asOfDate, 'PPP')} ({commitOutcomes.totals.count})
        </h3>
        <div className="grid grid-cols-6 gap-3 mb-3">
          {[
            { label: 'Starting Commit', value: fmt(commitOutcomes.totals.startingCommit), color: 'text-commit' },
            { label: 'Won', value: fmt(commitOutcomes.totals.won), color: 'text-positive' },
            { label: 'Lost', value: fmt(commitOutcomes.totals.lost), color: 'text-negative' },
            { label: 'Pushed Out', value: fmt(commitOutcomes.totals.pushed), color: 'text-upside' },
            { label: 'Downgraded', value: fmt(commitOutcomes.totals.downgraded), color: 'text-muted-foreground' },
            { label: 'Still Commit', value: fmt(commitOutcomes.totals.stillCommit), color: 'text-commit' },
          ].map(c => (
            <div key={c.label} className="bg-card border border-border rounded-lg p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{c.label}</p>
              <p className={`text-sm font-mono font-semibold ${c.color}`}>{c.value}</p>
            </div>
          ))}
        </div>
        {commitOutcomes.items.length === 0 ? (
          <div className="text-xs text-muted-foreground border border-border rounded-lg p-6 text-center">
            No deals were on Commit as of this date in the current scope.
          </div>
        ) : (
          <div className="border border-border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/50">
                  <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Outcome</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Opportunity</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Rep</th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Commit Amt</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Detail</th>
                </tr>
              </thead>
              <tbody>
                {commitOutcomes.items.map(i => {
                  const badge =
                    i.outcome === 'won' ? { label: 'Won', cls: 'bg-positive/15 text-positive' }
                    : i.outcome === 'lost' ? { label: 'Lost', cls: 'bg-negative/15 text-negative' }
                    : i.outcome === 'pushed' ? { label: 'Pushed', cls: 'bg-upside/15 text-upside' }
                    : i.outcome === 'downgraded' ? { label: 'Downgraded', cls: 'bg-secondary text-foreground' }
                    : i.outcome === 'removed' ? { label: 'Removed', cls: 'bg-negative/10 text-negative' }
                    : i.outcome === 'amount_changed' ? { label: 'Amount Δ', cls: 'bg-commit/10 text-commit' }
                    : { label: 'Held', cls: 'bg-secondary text-muted-foreground' };
                  return (
                    <tr key={i.id} className="border-b border-border last:border-0 hover:bg-secondary/30 transition-colors">
                      <td className="px-3 py-2">
                        <span className={`px-1.5 py-0.5 rounded text-xs ${badge.cls}`}>{badge.label}</span>
                      </td>
                      <td className="px-3 py-2 font-medium">{i.name}</td>
                      <td className="px-3 py-2 text-secondary-foreground text-xs">{i.repName}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{fmt(i.pastAmount)}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{i.detail}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Movement list */}
      <div>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          Movement since {format(asOfDate, 'PPP')} ({movementRows.length})
        </h3>
        {movementRows.length === 0 ? (
          <div className="text-xs text-muted-foreground border border-border rounded-lg p-6 text-center">
            No detected pipeline movement in scope. Try a different date, scope, or run an import to capture more snapshots.
          </div>
        ) : (
          <div className="border border-border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/50">
                  <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Type</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Opportunity</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Rep</th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Then</th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Now</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Changes</th>
                </tr>
              </thead>
              <tbody>
                {movementRows.map(r => {
                  const typeBadge =
                    r.type === 'new' ? { icon: <Plus size={10} />, label: 'New', cls: 'bg-positive/10 text-positive' }
                    : r.type === 'removed' ? { icon: <Minus size={10} />, label: 'Removed', cls: 'bg-negative/10 text-negative' }
                    : { icon: r.current && r.past && r.current.amount >= r.past.amount ? <TrendingUp size={10} /> : <TrendingDown size={10} />, label: 'Changed', cls: 'bg-upside/10 text-upside' };
                  return (
                    <tr key={r.id} className="border-b border-border last:border-0 hover:bg-secondary/30 transition-colors">
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs ${typeBadge.cls}`}>
                          {typeBadge.icon} {typeBadge.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-medium">{r.name}</td>
                      <td className="px-3 py-2 text-secondary-foreground text-xs">{r.repName}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                        {r.past ? fmt(r.past.amount) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {r.current ? fmt(r.current.amount) : '—'}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {r.changes.join(' · ')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
