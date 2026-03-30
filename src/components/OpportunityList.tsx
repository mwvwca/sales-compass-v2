import { useState, useMemo } from 'react';
import { useForecast } from '@/context/ForecastContext';
import type { Opportunity } from '@/types/forecast';
import { getMonthKey, getMonthLabel, getQuarterMonths, getWeeksInMonth, type Quarter, type WeekRange } from '@/types/forecast';
import { ArrowRightLeft, Check, X, Pencil, Search, ChevronUp, ChevronDown, ChevronsUpDown, History, StickyNote } from 'lucide-react';
import OpportunityHistory from './OpportunityHistory';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';

type SortField = 'name' | 'repName' | 'amount' | 'closeDate' | 'stage' | 'classification';
type SortDir = 'asc' | 'desc';

interface Props {
  opportunities: Opportunity[];
  lostOpportunities?: Opportunity[];
  quarter: Quarter;
}

type Classification = 'commit' | 'upside' | 'closed_won' | 'unclassified' | 'lost';

interface EditState {
  name: string;
  repName: string;
  amount: string;
  closeDate: string;
  stage: string;
}

const classificationFilters: { key: Classification; label: string }[] = [
  { key: 'closed_won', label: 'Won' },
  { key: 'commit', label: 'Commit' },
  { key: 'upside', label: 'Upside' },
  { key: 'unclassified', label: 'Unclassified' },
];

// Filter out lost opps from the main list

export default function OpportunityList({ opportunities, lostOpportunities = [], quarter }: Props) {
  const { classifyOpportunity, updateOpportunity } = useForecast();
  const [notesOpp, setNotesOpp] = useState<{ id: string; name: string } | null>(null);
  const [notesText, setNotesText] = useState('');
  const [selectedMonth, setSelectedMonth] = useState<string | 'all'>(() => {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const months = getQuarterMonths(quarter);
    return months.includes(currentMonth) ? currentMonth : 'all';
  });
  const [selectedWeek, setSelectedWeek] = useState<number | 'all'>('all');
  const [activeFilters, setActiveFilters] = useState<Set<Classification>>(new Set(['closed_won', 'commit', 'upside', 'unclassified']));
  const [searchQuery, setSearchQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState>({ name: '', repName: '', amount: '', closeDate: '', stage: '' });
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [historyOpp, setHistoryOpp] = useState<{ id: string; name: string } | null>(null);

  // Filter out lost/graveyard opps from the main list
  const activeOpportunities = useMemo(() => opportunities.filter(o => o.classification !== 'lost' && o.stage.toLowerCase().trim() !== 'closed lost'), [opportunities]);

  const months = getQuarterMonths(quarter);
  const weeks: WeekRange[] = useMemo(() => {
    if (selectedMonth === 'all') return [];
    return getWeeksInMonth(selectedMonth);
  }, [selectedMonth]);

  const handleMonthChange = (m: string | 'all') => {
    setSelectedMonth(m);
    setSelectedWeek('all');
  };

  const toggleFilter = (cls: Classification) => {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(cls)) next.delete(cls);
      else next.add(cls);
      return next;
    });
  };

  const monthFiltered = selectedMonth === 'all'
    ? activeOpportunities
    : activeOpportunities.filter(o => getMonthKey(o.closeDate) === selectedMonth);

  const weekFiltered = useMemo(() => {
    if (selectedWeek === 'all' || weeks.length === 0) return monthFiltered;
    const week = weeks[selectedWeek];
    if (!week) return monthFiltered;
    return monthFiltered.filter(o => {
      const d = new Date(o.closeDate);
      return d >= week.start && d <= week.end;
    });
  }, [monthFiltered, selectedWeek, weeks]);

  const searchFiltered = useMemo(() => {
    if (!searchQuery.trim()) return weekFiltered;
    const q = searchQuery.toLowerCase();
    return weekFiltered.filter(o =>
      o.name.toLowerCase().includes(q) ||
      o.repName.toLowerCase().includes(q) ||
      o.stage.toLowerCase().includes(q)
    );
  }, [weekFiltered, searchQuery]);

  const classFiltered = searchFiltered.filter(o => activeFilters.has(o.classification));

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      if (sortDir === 'asc') setSortDir('desc');
      else { setSortField(null); setSortDir('asc'); }
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const classOrder: Record<string, number> = { closed_won: 0, commit: 1, upside: 2, unclassified: 3 };

  const filtered = useMemo(() => {
    if (!sortField) return classFiltered;
    return [...classFiltered].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'amount') cmp = a.amount - b.amount;
      else if (sortField === 'classification') cmp = (classOrder[a.classification] ?? 9) - (classOrder[b.classification] ?? 9);
      else cmp = String(a[sortField]).localeCompare(String(b[sortField]));
      return sortDir === 'desc' ? -cmp : cmp;
    });
  }, [classFiltered, sortField, sortDir]);

  // Footer metrics (conversion rates include lost opportunities in denominator)
  const footerMetrics = useMemo(() => {
    const lostAmount = lostOpportunities.reduce((s, o) => s + o.amount, 0);
    const lostCount = lostOpportunities.length;
    const totalAmount = filtered.reduce((s, o) => s + o.amount, 0);
    const totalCount = filtered.length;
    const allAmount = totalAmount + lostAmount;
    const allCount = totalCount + lostCount;
    const wonAmount = filtered.filter(o => o.classification === 'closed_won').reduce((s, o) => s + o.amount, 0);
    const wonCount = filtered.filter(o => o.classification === 'closed_won').length;
    const conversionRate = allAmount > 0 ? (wonAmount / allAmount) * 100 : 0;
    const countConvRate = allCount > 0 ? (wonCount / allCount) * 100 : 0;
    const avgSalePrice = wonCount > 0 ? wonAmount / wonCount : 0;

    // Per-rep metrics (including lost opps per rep in denominator)
    const repMap = new Map<string, { total: number; won: number; wonCount: number; totalCount: number }>();
    for (const o of filtered) {
      const entry = repMap.get(o.repName) || { total: 0, won: 0, wonCount: 0, totalCount: 0 };
      entry.total += o.amount;
      entry.totalCount++;
      if (o.classification === 'closed_won') { entry.won += o.amount; entry.wonCount++; }
      repMap.set(o.repName, entry);
    }
    for (const o of lostOpportunities) {
      const entry = repMap.get(o.repName) || { total: 0, won: 0, wonCount: 0, totalCount: 0 };
      entry.total += o.amount;
      entry.totalCount++;
      repMap.set(o.repName, entry);
    }

    return { totalAmount, totalCount, wonAmount, wonCount, conversionRate, countConvRate, avgSalePrice, repMetrics: repMap };
  }, [filtered, lostOpportunities]);

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ChevronsUpDown size={12} className="text-muted-foreground/50" />;
    return sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />;
  };

  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  const startEdit = (opp: Opportunity) => {
    setEditingId(opp.id);
    setEditState({
      name: opp.name,
      repName: opp.repName,
      amount: String(opp.amount),
      closeDate: opp.closeDate,
      stage: opp.stage,
    });
  };

  const saveEdit = (id: string) => {
    const parsed = parseFloat(editState.amount);
    updateOpportunity(id, {
      name: editState.name,
      repName: editState.repName,
      amount: isNaN(parsed) || parsed < 0 ? 0 : parsed,
      closeDate: editState.closeDate,
      stage: editState.stage,
    });
    setEditingId(null);
  };

  const cancelEdit = () => setEditingId(null);

  const handleKey = (e: React.KeyboardEvent, id: string) => {
    if (e.key === 'Enter') saveEdit(id);
    if (e.key === 'Escape') cancelEdit();
  };

  const inputClass = "bg-secondary border border-border rounded px-2 py-0.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring";

  const classBtn = (opp: Opportunity, cls: Classification, label: string) => {
    const active = opp.classification === cls;
    const colors: Record<string, string> = {
      closed_won: active ? 'bg-positive/20 text-positive border-positive/40' : 'text-muted-foreground border-border hover:border-positive/40 hover:text-positive',
      commit: active ? 'bg-commit/20 text-commit border-commit/40' : 'text-muted-foreground border-border hover:border-commit/40 hover:text-commit',
      upside: active ? 'bg-upside/20 text-upside border-upside/40' : 'text-muted-foreground border-border hover:border-upside/40 hover:text-upside',
      unclassified: active ? 'bg-secondary text-foreground border-foreground/20' : 'text-muted-foreground border-border hover:text-foreground',
    };
    return (
      <button
        key={cls}
        onClick={() => classifyOpportunity(opp.id, cls)}
        className={`px-2 py-0.5 text-xs rounded border transition-colors ${colors[cls]}`}
      >
        {label}
      </button>
    );
  };

  const moved = filtered.filter(o => o.previousClassification && o.previousClassification !== o.classification);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Opportunities ({filtered.length})
          </h3>
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search..."
              className="bg-secondary border border-border rounded px-2 pl-6 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring w-44"
            />
          </div>
          <div className="flex gap-1 bg-secondary rounded-md p-0.5">
            <button
              onClick={() => handleMonthChange('all')}
              className={`px-2 py-1 text-xs font-mono rounded transition-colors ${selectedMonth === 'all' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}
            >
              All
            </button>
            {months.map(m => (
              <button
                key={m}
                onClick={() => handleMonthChange(m)}
                className={`px-2 py-1 text-xs font-mono rounded transition-colors ${selectedMonth === m ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {getMonthLabel(m)}
              </button>
            ))}
          </div>
          {selectedMonth !== 'all' && weeks.length > 0 && (
            <div className="flex gap-1 bg-secondary rounded-md p-0.5">
              <button
                onClick={() => setSelectedWeek('all')}
                className={`px-2 py-1 text-xs font-mono rounded transition-colors ${selectedWeek === 'all' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}
              >
                All
              </button>
              {weeks.map((w, i) => (
                <button
                  key={i}
                  onClick={() => setSelectedWeek(i)}
                  className={`px-2 py-1 text-xs font-mono rounded transition-colors ${selectedWeek === i ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}
                  title={`${w.start.toLocaleDateString()} – ${w.end.toLocaleDateString()}`}
                >
                  {w.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          {classificationFilters.map(f => {
            const active = activeFilters.has(f.key);
            const colorMap: Record<string, string> = {
              closed_won: active ? 'bg-positive/20 text-positive border-positive/40' : 'text-muted-foreground border-border',
              commit: active ? 'bg-commit/20 text-commit border-commit/40' : 'text-muted-foreground border-border',
              upside: active ? 'bg-upside/20 text-upside border-upside/40' : 'text-muted-foreground border-border',
              unclassified: active ? 'bg-secondary text-foreground border-foreground/20' : 'text-muted-foreground border-border',
            };
            return (
              <button
                key={f.key}
                onClick={() => toggleFilter(f.key)}
                className={`px-2 py-0.5 text-xs rounded border transition-colors ${colorMap[f.key]}`}
              >
                {f.label}
              </button>
            );
          })}
          {moved.length > 0 && (
            <span className="ml-2 text-xs text-upside flex items-center gap-1">
              <ArrowRightLeft size={12} /> {moved.length} moved
            </span>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground text-sm">
          No opportunities for this period. Import a Salesforce export to get started.
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                <th onClick={() => toggleSort('name')} className="text-left px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer select-none hover:text-foreground transition-colors"><span className="inline-flex items-center gap-1">Opportunity <SortIcon field="name" /></span></th>
                <th onClick={() => toggleSort('repName')} className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer select-none hover:text-foreground transition-colors"><span className="inline-flex items-center gap-1">Rep <SortIcon field="repName" /></span></th>
                <th onClick={() => toggleSort('amount')} className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer select-none hover:text-foreground transition-colors"><span className="inline-flex items-center gap-1 justify-end">Amount <SortIcon field="amount" /></span></th>
                <th onClick={() => toggleSort('closeDate')} className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer select-none hover:text-foreground transition-colors"><span className="inline-flex items-center gap-1">Close <SortIcon field="closeDate" /></span></th>
                <th onClick={() => toggleSort('stage')} className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer select-none hover:text-foreground transition-colors"><span className="inline-flex items-center gap-1">Stage <SortIcon field="stage" /></span></th>
                <th onClick={() => toggleSort('classification')} className="text-center px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer select-none hover:text-foreground transition-colors"><span className="inline-flex items-center gap-1 justify-center">Classification <SortIcon field="classification" /></span></th>
                <th className="w-16 px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(opp => {
                const isEditing = editingId === opp.id;
                return (
                  <tr key={opp.id} className="border-b border-border last:border-0 hover:bg-secondary/30 transition-colors">
                    <td className="px-4 py-2.5">
                      {isEditing ? (
                        <input value={editState.name} onChange={e => setEditState(s => ({ ...s, name: e.target.value }))} onKeyDown={e => handleKey(e, opp.id)} className={`${inputClass} w-full`} autoFocus />
                      ) : (
                        <>
                          <span className="font-medium">{opp.name}</span>
                          {opp.previousClassification && opp.previousClassification !== opp.classification && (
                            <span className="ml-2 text-xs text-upside">{opp.previousClassification} → {opp.classification}</span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {isEditing ? (
                        <input value={editState.repName} onChange={e => setEditState(s => ({ ...s, repName: e.target.value }))} onKeyDown={e => handleKey(e, opp.id)} className={`${inputClass} w-full`} />
                      ) : (
                        <span className="text-secondary-foreground">{opp.repName}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono">
                      {isEditing ? (
                        <input type="number" value={editState.amount} onChange={e => setEditState(s => ({ ...s, amount: e.target.value }))} onKeyDown={e => handleKey(e, opp.id)} className={`${inputClass} w-24 text-right`} />
                      ) : (
                        <span>{fmt(opp.amount)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {isEditing ? (
                        <input type="date" value={editState.closeDate} onChange={e => setEditState(s => ({ ...s, closeDate: e.target.value }))} onKeyDown={e => handleKey(e, opp.id)} className={`${inputClass} w-32`} />
                      ) : (
                        <span className="font-mono text-secondary-foreground">{opp.closeDate}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {isEditing ? (
                        <input value={editState.stage} onChange={e => setEditState(s => ({ ...s, stage: e.target.value }))} onKeyDown={e => handleKey(e, opp.id)} className={`${inputClass} w-full`} />
                      ) : (
                        <span className="text-secondary-foreground">{opp.stage}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex justify-center gap-1">
                        {classBtn(opp, 'closed_won', 'Won')}
                        {classBtn(opp, 'commit', 'Commit')}
                        {classBtn(opp, 'upside', 'Upside')}
                        {classBtn(opp, 'unclassified', '—')}
                      </div>
                    </td>
                    <td className="px-2 py-2.5">
                      {isEditing ? (
                        <div className="flex gap-1">
                          <button onClick={() => saveEdit(opp.id)} className="text-positive hover:text-positive/80"><Check size={14} /></button>
                          <button onClick={cancelEdit} className="text-negative hover:text-negative/80"><X size={14} /></button>
                        </div>
                      ) : (
                        <div className="flex gap-1">
                          <button onClick={() => setHistoryOpp({ id: opp.id, name: opp.name })} className="text-muted-foreground hover:text-foreground transition-colors" title="View history">
                            <History size={12} />
                          </button>
                          <button onClick={() => startEdit(opp)} className="text-muted-foreground hover:text-foreground transition-colors">
                            <Pencil size={12} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {/* Footer with totals and metrics */}
            <tfoot>
              <tr className="border-t-2 border-border bg-secondary/50">
                <td className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Totals
                </td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">
                  {footerMetrics.repMetrics.size} reps
                </td>
                <td className="px-3 py-2.5 text-right font-mono font-semibold">
                  {fmt(footerMetrics.totalAmount)}
                </td>
                <td colSpan={2} className="px-3 py-2.5">
                  <div className="flex gap-4 text-xs">
                    <span className="text-muted-foreground">
                      Conv $: <span className={`font-mono font-semibold ${footerMetrics.conversionRate > 0 ? 'text-positive' : 'text-muted-foreground'}`}>
                        {footerMetrics.conversionRate.toFixed(1)}%
                      </span>
                    </span>
                    <span className="text-muted-foreground">
                      Conv #: <span className={`font-mono font-semibold ${footerMetrics.countConvRate > 0 ? 'text-positive' : 'text-muted-foreground'}`}>
                        {footerMetrics.countConvRate.toFixed(1)}%
                      </span>
                    </span>
                    <span className="text-muted-foreground">
                      Avg Sale: <span className={`font-mono font-semibold ${footerMetrics.avgSalePrice > 0 ? 'text-commit' : 'text-muted-foreground'}`}>
                        {footerMetrics.avgSalePrice > 0 ? fmt(footerMetrics.avgSalePrice) : '—'}
                      </span>
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2.5 text-center text-xs text-muted-foreground">
                  {footerMetrics.wonCount} won
                </td>
                <td className="px-2 py-2.5"></td>
              </tr>
              {/* Per-rep breakdown when multiple reps */}
              {footerMetrics.repMetrics.size > 1 && Array.from(footerMetrics.repMetrics.entries()).map(([rep, metrics]) => {
                const convRate = metrics.total > 0 ? (metrics.won / metrics.total) * 100 : 0;
                const countConv = metrics.totalCount > 0 ? (metrics.wonCount / metrics.totalCount) * 100 : 0;
                const asp = metrics.wonCount > 0 ? metrics.won / metrics.wonCount : 0;
                return (
                  <tr key={rep} className="border-t border-border bg-secondary/30">
                    <td className="px-4 py-1.5 text-xs text-muted-foreground pl-8">
                      {rep}
                    </td>
                    <td className="px-3 py-1.5"></td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs">
                      {fmt(metrics.total)}
                    </td>
                    <td colSpan={2} className="px-3 py-1.5">
                      <div className="flex gap-4 text-xs">
                        <span className="text-muted-foreground">
                          Conv $: <span className={`font-mono ${convRate > 0 ? 'text-positive' : 'text-muted-foreground'}`}>{convRate.toFixed(1)}%</span>
                        </span>
                        <span className="text-muted-foreground">
                          Conv #: <span className={`font-mono ${countConv > 0 ? 'text-positive' : 'text-muted-foreground'}`}>{countConv.toFixed(1)}%</span>
                        </span>
                        <span className="text-muted-foreground">
                          ASP: <span className={`font-mono ${asp > 0 ? 'text-commit' : 'text-muted-foreground'}`}>{asp > 0 ? fmt(asp) : '—'}</span>
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-center text-xs text-muted-foreground">
                      {metrics.wonCount} won
                    </td>
                    <td className="px-2 py-1.5"></td>
                  </tr>
                );
              })}
            </tfoot>
          </table>
        </div>
      )}

      {historyOpp && (
        <OpportunityHistory
          opportunityId={historyOpp.id}
          opportunityName={historyOpp.name}
          onClose={() => setHistoryOpp(null)}
        />
      )}
    </div>
  );
}
