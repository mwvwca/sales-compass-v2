import { useState, useMemo } from 'react';
import { useForecast } from '@/context/ForecastContext';
import type { Opportunity } from '@/types/forecast';
import { Check, Plus, RefreshCw, Minus } from 'lucide-react';

interface Props {
  incoming: Opportunity[];
  fileName: string;
  onDone: () => void;
  onCancel: () => void;
}

type ChangeType = 'new' | 'updated' | 'unchanged';

interface ReviewItem {
  opportunity: Opportunity;
  existing?: Opportunity;
  changeType: ChangeType;
  changes: string[];
  selected: boolean;
}

export default function ImportReview({ incoming, fileName, onDone, onCancel }: Props) {
  const { opportunities, importOpportunities } = useForecast();

  const existingMap = useMemo(() => new Map(opportunities.map(o => [o.id, o])), [opportunities]);

  const [items, setItems] = useState<ReviewItem[]>(() =>
    incoming.map(opp => {
      const existing = existingMap.get(opp.id);
      if (!existing) {
        return { opportunity: opp, changeType: 'new' as ChangeType, changes: [], selected: true };
      }
      const changes: string[] = [];
      if (existing.amount !== opp.amount) changes.push(`Amount: ${fmt(existing.amount)} → ${fmt(opp.amount)}`);
      if (existing.closeDate !== opp.closeDate) changes.push(`Close: ${existing.closeDate} → ${opp.closeDate}`);
      if (existing.stage.trim() !== opp.stage.trim()) changes.push(`Stage: ${existing.stage} → ${opp.stage}`);
      if (existing.repName !== opp.repName) changes.push(`Rep: ${existing.repName} → ${opp.repName}`);
      if (existing.name !== opp.name) changes.push(`Name: ${existing.name} → ${opp.name}`);
      const changeType: ChangeType = changes.length > 0 ? 'updated' : 'unchanged';
      return { opportunity: opp, existing, changeType, changes, selected: changes.length > 0 };
    })
  );

  const toggle = (id: string) => setItems(prev => prev.map(i => i.opportunity.id === id ? { ...i, selected: !i.selected } : i));
  const selectAll = (type: ChangeType) => setItems(prev => prev.map(i => i.changeType === type ? { ...i, selected: true } : i));
  const deselectAll = (type: ChangeType) => setItems(prev => prev.map(i => i.changeType === type ? { ...i, selected: false } : i));

  const counts = useMemo(() => ({
    new: items.filter(i => i.changeType === 'new').length,
    updated: items.filter(i => i.changeType === 'updated').length,
    unchanged: items.filter(i => i.changeType === 'unchanged').length,
    selected: items.filter(i => i.selected).length,
  }), [items]);

  const handleApprove = () => {
    const selected = items.filter(i => i.selected).map(i => i.opportunity);
    if (selected.length > 0) {
      importOpportunities(selected, fileName);
    }
    onDone();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h3 className="text-sm font-semibold">Review Import: {fileName}</h3>
        <div className="flex gap-2 text-xs">
          {counts.new > 0 && (
            <span className="flex items-center gap-1 text-positive bg-positive/10 px-2 py-0.5 rounded">
              <Plus size={12} /> {counts.new} new
            </span>
          )}
          {counts.updated > 0 && (
            <span className="flex items-center gap-1 text-upside bg-upside/10 px-2 py-0.5 rounded">
              <RefreshCw size={12} /> {counts.updated} updated
            </span>
          )}
          {counts.unchanged > 0 && (
            <span className="flex items-center gap-1 text-muted-foreground bg-secondary px-2 py-0.5 rounded">
              <Minus size={12} /> {counts.unchanged} unchanged
            </span>
          )}
        </div>
      </div>

      <div className="flex gap-2 text-xs">
        {counts.new > 0 && (
          <div className="flex gap-1">
            <button onClick={() => selectAll('new')} className="text-muted-foreground hover:text-foreground underline">Select all new</button>
            <span className="text-muted-foreground">/</span>
            <button onClick={() => deselectAll('new')} className="text-muted-foreground hover:text-foreground underline">Deselect</button>
          </div>
        )}
        {counts.updated > 0 && (
          <div className="flex gap-1">
            <button onClick={() => selectAll('updated')} className="text-muted-foreground hover:text-foreground underline">Select all updated</button>
            <span className="text-muted-foreground">/</span>
            <button onClick={() => deselectAll('updated')} className="text-muted-foreground hover:text-foreground underline">Deselect</button>
          </div>
        )}
      </div>

      <div className="border border-border rounded-lg overflow-hidden max-h-96 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0">
            <tr className="border-b border-border bg-secondary/50">
              <th className="w-8 px-3 py-2"></th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Type</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Opportunity</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Rep</th>
              <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Amount</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Changes</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr
                key={item.opportunity.id}
                onClick={() => toggle(item.opportunity.id)}
                className={`border-b border-border last:border-0 cursor-pointer transition-colors ${
                  item.selected ? 'bg-secondary/20' : 'opacity-50'
                } hover:bg-secondary/40`}
              >
                <td className="px-3 py-2 text-center">
                  <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                    item.selected ? 'bg-foreground border-foreground' : 'border-border'
                  }`}>
                    {item.selected && <Check size={10} className="text-background" />}
                  </div>
                </td>
                <td className="px-3 py-2">
                  {item.changeType === 'new' && <span className="text-xs text-positive bg-positive/10 px-1.5 py-0.5 rounded">New</span>}
                  {item.changeType === 'updated' && <span className="text-xs text-upside bg-upside/10 px-1.5 py-0.5 rounded">Updated</span>}
                  {item.changeType === 'unchanged' && <span className="text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">Same</span>}
                </td>
                <td className="px-3 py-2 font-medium">{item.opportunity.name}</td>
                <td className="px-3 py-2 text-secondary-foreground">{item.opportunity.repName}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(item.opportunity.amount)}</td>
                <td className="px-3 py-2">
                  {item.changes.length > 0 ? (
                    <div className="space-y-0.5">
                      {item.changes.map((c, i) => (
                        <div key={i} className="text-xs text-upside">{c}</div>
                      ))}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between pt-2">
        <p className="text-xs text-muted-foreground">{counts.selected} of {items.length} selected</p>
        <div className="flex gap-2">
          <button onClick={onCancel} className="px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground border border-border rounded-md transition-colors">
            Cancel
          </button>
          <button
            onClick={handleApprove}
            disabled={counts.selected === 0}
            className="px-4 py-2 text-xs font-medium bg-foreground text-background rounded-md hover:bg-foreground/90 transition-colors disabled:opacity-50"
          >
            Import {counts.selected} {counts.selected === 1 ? 'opportunity' : 'opportunities'}
          </button>
        </div>
      </div>
    </div>
  );
}

function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
