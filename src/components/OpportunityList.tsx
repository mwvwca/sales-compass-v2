import { useState, useMemo } from 'react';
import { useForecast } from '@/context/ForecastContext';
import type { Opportunity } from '@/types/forecast';
import { getMonthKey, getMonthLabel, getQuarterMonths, getWeeksInMonth, type Quarter, type WeekRange } from '@/types/forecast';
import { ArrowRightLeft, Check, X, Pencil, Search } from 'lucide-react';

interface Props {
  opportunities: Opportunity[];
  quarter: Quarter;
}

type Classification = 'commit' | 'upside' | 'closed_won' | 'unclassified';

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

export default function OpportunityList({ opportunities, quarter }: Props) {
  const { classifyOpportunity, updateOpportunity } = useForecast();
  const [selectedMonth, setSelectedMonth] = useState<string | 'all'>('all');
  const [selectedWeek, setSelectedWeek] = useState<number | 'all'>('all');
  const [activeFilters, setActiveFilters] = useState<Set<Classification>>(new Set(['closed_won', 'commit', 'upside', 'unclassified']));
  const [searchQuery, setSearchQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState>({ name: '', repName: '', amount: '', closeDate: '', stage: '' });

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
    ? opportunities
    : opportunities.filter(o => getMonthKey(o.closeDate) === selectedMonth);

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

  const filtered = searchFiltered.filter(o => activeFilters.has(o.classification));

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
                <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Opportunity</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Rep</th>
                <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Amount</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Close</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Stage</th>
                <th className="text-center px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Classification</th>
                <th className="w-8 px-2 py-2"></th>
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
                        <button onClick={() => startEdit(opp)} className="text-muted-foreground hover:text-foreground transition-colors">
                          <Pencil size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
