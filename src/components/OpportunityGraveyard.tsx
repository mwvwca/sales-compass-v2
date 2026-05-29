import { useState, useMemo } from 'react';
import { useForecast } from '@/context/ForecastContext';
import type { Opportunity } from '@/types/forecast';
import { RotateCcw, Trash2, Search, ArrowUp, ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';

type SortField = 'name' | 'repName' | 'amount' | 'stage' | 'lostDate';
type SortDir = 'asc' | 'desc' | null;

export default function OpportunityGraveyard() {
  const { opportunities, restoreFromGraveyard, deleteOpportunity } = useForecast();
  const [searchQuery, setSearchQuery] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [typeFilter, setTypeFilter] = useState<'all' | 'lost' | 'rejected'>('all');

  const lostOpps = useMemo(() => {
    return opportunities
      .filter(o => o.classification === 'lost' || o.classification === 'rejected')
      .filter(o => typeFilter === 'all' || o.classification === typeFilter)
      .sort((a, b) => new Date(b.lostDate || b.importDate).getTime() - new Date(a.lostDate || a.importDate).getTime());
  }, [opportunities, typeFilter]);

  const lostCount = useMemo(() => opportunities.filter(o => o.classification === 'lost').length, [opportunities]);
  const rejectedCount = useMemo(() => opportunities.filter(o => o.classification === 'rejected').length, [opportunities]);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return lostOpps;
    const q = searchQuery.toLowerCase();
    return lostOpps.filter(o =>
      o.name.toLowerCase().includes(q) ||
      o.repName.toLowerCase().includes(q)
    );
  }, [lostOpps, searchQuery]);

  const sorted = useMemo(() => {
    if (!sortField || !sortDir) return filtered;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'name': cmp = a.name.localeCompare(b.name); break;
        case 'repName': cmp = a.repName.localeCompare(b.repName); break;
        case 'amount': cmp = a.amount - b.amount; break;
        case 'stage': cmp = a.stage.localeCompare(b.stage); break;
        case 'lostDate': cmp = new Date(a.lostDate || a.importDate).getTime() - new Date(b.lostDate || b.importDate).getTime(); break;
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });
  }, [filtered, sortField, sortDir]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      if (sortDir === 'asc') setSortDir('desc');
      else if (sortDir === 'desc') { setSortField(null); setSortDir(null); }
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />;
  };

  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  const totalLostValue = lostOpps.reduce((s, o) => s + o.amount, 0);

  const repGroups = useMemo(() => {
    const map = new Map<string, { count: number; amount: number }>();
    for (const o of lostOpps) {
      const entry = map.get(o.repName) || { count: 0, amount: 0 };
      entry.count++;
      entry.amount += o.amount;
      map.set(o.repName, entry);
    }
    return map;
  }, [lostOpps]);

  if (lostOpps.length === 0) {
    return (
      <div className="text-center py-16">
        <Trash2 size={32} className="mx-auto text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">No lost opportunities yet.</p>
        <p className="text-xs text-muted-foreground/60 mt-1">
          Opportunities removed during import will appear here.
        </p>
      </div>
    );
  }

  const thClass = "text-left px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer hover:text-foreground transition-colors select-none";

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Lost Opportunities</p>
          <p className="text-xl font-mono font-semibold text-destructive">{lostOpps.length}</p>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Lost Pipeline Value</p>
          <p className="text-xl font-mono font-semibold text-destructive">{fmt(totalLostValue)}</p>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Reps Affected</p>
          <p className="text-xl font-mono font-semibold">{repGroups.size}</p>
        </div>
      </div>

      {/* Per-rep summary */}
      {repGroups.size > 1 && (
        <div className="flex flex-wrap gap-2">
          {Array.from(repGroups.entries()).map(([rep, data]) => (
            <button key={rep} onClick={() => setSearchQuery(searchQuery === rep ? '' : rep)} className={`text-xs px-2 py-1 rounded-md font-medium transition-colors ${searchQuery === rep ? 'bg-destructive text-destructive-foreground' : 'bg-destructive/10 text-destructive hover:bg-destructive/20'}`}>
              {rep}: {data.count} opps · {fmt(data.amount)}
            </button>
          ))}
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search lost opportunities..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="w-full pl-9 pr-3 py-2 text-sm bg-secondary border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Table */}
      <div className="border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/50">
              <th className={`${thClass} px-4`} onClick={() => handleSort('name')}>
                <span className="flex items-center gap-1">Opportunity <SortIcon field="name" /></span>
              </th>
              <th className={thClass} onClick={() => handleSort('repName')}>
                <span className="flex items-center gap-1">Rep <SortIcon field="repName" /></span>
              </th>
              <th className={`${thClass} text-right`} onClick={() => handleSort('amount')}>
                <span className="flex items-center justify-end gap-1">Amount <SortIcon field="amount" /></span>
              </th>
              <th className={thClass} onClick={() => handleSort('stage')}>
                <span className="flex items-center gap-1">Last Stage <SortIcon field="stage" /></span>
              </th>
              <th className={thClass} onClick={() => handleSort('lostDate')}>
                <span className="flex items-center gap-1">Lost Date <SortIcon field="lostDate" /></span>
              </th>
              <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Reason</th>
              <th className="text-center px-2 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(opp => (
              <tr key={opp.id} className="border-b border-border last:border-0 hover:bg-secondary/30 transition-colors">
                <td className="px-4 py-2.5 font-medium">{opp.name}</td>
                <td className="px-3 py-2.5 text-muted-foreground">
                  <button onClick={() => setSearchQuery(opp.repName)} className="hover:underline hover:text-foreground transition-colors">{opp.repName}</button>
                </td>
                <td className="px-3 py-2.5 text-right font-mono">{fmt(opp.amount)}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{opp.stage}</td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground font-mono">
                  {opp.lostDate ? new Date(opp.lostDate).toLocaleDateString() : '—'}
                </td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">{opp.lostReason || '—'}</td>
                <td className="px-2 py-2.5 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <button
                      onClick={() => restoreFromGraveyard(opp.id)}
                      className="p-1.5 rounded hover:bg-positive/10 text-muted-foreground hover:text-positive transition-colors"
                      title="Restore to pipeline"
                    >
                      <RotateCcw size={14} />
                    </button>
                    <Dialog open={confirmDelete === opp.id} onOpenChange={open => !open && setConfirmDelete(null)}>
                      <DialogTrigger asChild>
                        <button
                          onClick={() => setConfirmDelete(opp.id)}
                          className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                          title="Permanently delete"
                        >
                          <Trash2 size={14} />
                        </button>
                      </DialogTrigger>
                      <DialogContent className="max-w-sm">
                        <DialogHeader>
                          <DialogTitle>Permanently Delete?</DialogTitle>
                        </DialogHeader>
                        <p className="text-sm text-muted-foreground">
                          This will permanently remove <strong>{opp.name}</strong> ({fmt(opp.amount)}). This cannot be undone.
                        </p>
                        <DialogFooter>
                          <Button variant="outline" size="sm" onClick={() => setConfirmDelete(null)}>Cancel</Button>
                          <Button variant="destructive" size="sm" onClick={() => { deleteOpportunity(opp.id); setConfirmDelete(null); }}>
                            Delete Forever
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
