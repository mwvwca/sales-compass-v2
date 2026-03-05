import { useState, useMemo } from 'react';
import { useForecast } from '@/context/ForecastContext';
import type { Opportunity } from '@/types/forecast';
import { getQuarter, getCurrentQuarter, type Quarter } from '@/types/forecast';
import { RotateCcw, Trash2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';

export default function OpportunityGraveyard() {
  const { opportunities, restoreFromGraveyard, deleteOpportunity } = useForecast();
  const [searchQuery, setSearchQuery] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const lostOpps = useMemo(() => {
    return opportunities
      .filter(o => o.classification === 'lost')
      .sort((a, b) => new Date(b.lostDate || b.importDate).getTime() - new Date(a.lostDate || a.importDate).getTime());
  }, [opportunities]);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return lostOpps;
    const q = searchQuery.toLowerCase();
    return lostOpps.filter(o =>
      o.name.toLowerCase().includes(q) ||
      o.repName.toLowerCase().includes(q)
    );
  }, [lostOpps, searchQuery]);

  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  const totalLostValue = lostOpps.reduce((s, o) => s + o.amount, 0);

  // Group by rep
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
            <span key={rep} className="text-xs bg-destructive/10 text-destructive px-2 py-1 rounded-md font-medium">
              {rep}: {data.count} opps · {fmt(data.amount)}
            </span>
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
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Opportunity</th>
              <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Rep</th>
              <th className="text-right px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Amount</th>
              <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Last Stage</th>
              <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Lost Date</th>
              <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Reason</th>
              <th className="text-center px-2 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(opp => (
              <tr key={opp.id} className="border-b border-border last:border-0 hover:bg-secondary/30 transition-colors">
                <td className="px-4 py-2.5 font-medium">{opp.name}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{opp.repName}</td>
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
