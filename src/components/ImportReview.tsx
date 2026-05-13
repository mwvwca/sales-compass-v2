import { useState, useMemo } from 'react';
import { useForecast } from '@/context/ForecastContext';
import type { Opportunity } from '@/types/forecast';
import { resolveImportedClassification } from '@/lib/forecastClassification';
import { normalizeRepName } from '@/lib/repUtils';
import { Check, Plus, RefreshCw, Minus, Trash2 } from 'lucide-react';

interface Props {
  incoming: Opportunity[];
  fileName: string;
  onDone: () => void;
  onCancel: () => void;
}

type ChangeType = 'new' | 'updated' | 'unchanged' | 'removed';

interface ReviewItem {
  opportunity: Opportunity;
  existing?: Opportunity;
  changeType: ChangeType;
  changes: string[];
  selected: boolean;
}

export default function ImportReview({ incoming, fileName, onDone, onCancel }: Props) {
  const { opportunities, importOpportunities, archiveToGraveyard } = useForecast();

  const existingMap = useMemo(() => new Map(opportunities.map(o => [o.id, o])), [opportunities]);

  // Reps present in the incoming file — only flag removals for these reps
  const incomingRepNames = useMemo(() => new Set(incoming.map(o => normalizeRepName(o.repName))), [incoming]);
  const incomingIds = useMemo(() => new Set(incoming.map(o => o.id)), [incoming]);

  const [showAllUnmatched, setShowAllUnmatched] = useState(false);

  const buildIncomingItems = (): ReviewItem[] => incoming.map(opp => {
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
    if ((existing.productName || '') !== (opp.productName || '')) {
      changes.push(`Product: ${existing.productName || '(empty)'} → ${opp.productName || '(empty)'}`);
    }
    const resolvedClassification = resolveImportedClassification(existing.classification, opp.classification);
    if (existing.classification !== resolvedClassification) {
      changes.push(`Classification: ${existing.classification} → ${resolvedClassification}`);
    } else if (existing.classification !== opp.classification) {
      changes.push(`Classification held: ${existing.classification} (import suggested ${opp.classification})`);
    }
    const changeType: ChangeType = changes.length > 0 ? 'updated' : 'unchanged';
    return { opportunity: opp, existing, changeType, changes, selected: changes.length > 0 };
  });

  const buildRemovedItems = (allUnmatched: boolean): ReviewItem[] => opportunities
    .filter(o => o.classification !== 'lost' && o.classification !== 'omitted' && !incomingIds.has(o.id) && (allUnmatched || incomingRepNames.has(normalizeRepName(o.repName))))
    .map(o => ({
      opportunity: o,
      existing: o,
      changeType: 'removed' as ChangeType,
      changes: [incomingRepNames.has(normalizeRepName(o.repName)) ? 'No longer in import file' : 'Rep not in import file'],
      selected: false,
    }));

  const [items, setItems] = useState<ReviewItem[]>(() => [...buildIncomingItems(), ...buildRemovedItems(false)]);

  const handleToggleAllUnmatched = () => {
    const next = !showAllUnmatched;
    setShowAllUnmatched(next);
    const incomingItems = buildIncomingItems();
    const removedItems = buildRemovedItems(next);
    // Preserve selections from current items
    const selectionMap = new Map(items.map(i => [i.opportunity.id, i.selected]));
    const merged = [...incomingItems, ...removedItems].map(i => ({
      ...i,
      selected: selectionMap.has(i.opportunity.id) ? selectionMap.get(i.opportunity.id)! : i.selected,
    }));
    setItems(merged);
  };

  const toggle = (id: string) => setItems(prev => prev.map(i => i.opportunity.id === id ? { ...i, selected: !i.selected } : i));
  const selectAll = (type: ChangeType) => setItems(prev => prev.map(i => i.changeType === type ? { ...i, selected: true } : i));
  const deselectAll = (type: ChangeType) => setItems(prev => prev.map(i => i.changeType === type ? { ...i, selected: false } : i));

  const counts = useMemo(() => ({
    new: items.filter(i => i.changeType === 'new').length,
    updated: items.filter(i => i.changeType === 'updated').length,
    unchanged: items.filter(i => i.changeType === 'unchanged').length,
    removed: items.filter(i => i.changeType === 'removed').length,
    selected: items.filter(i => i.selected).length,
    removedSelected: items.filter(i => i.changeType === 'removed' && i.selected).length,
  }), [items]);

  const [showUnchanged, setShowUnchanged] = useState(false);
  const [showRemoved, setShowRemoved] = useState(true);

  const visibleItems = useMemo(() => {
    return items.filter(i => {
      if (i.changeType === 'unchanged' && !showUnchanged) return false;
      if (i.changeType === 'removed' && !showRemoved) return false;
      return true;
    });
  }, [items, showUnchanged, showRemoved]);

  const handleApprove = () => {
    // Import selected new/updated/unchanged
    const toImport = items.filter(i => i.selected && i.changeType !== 'removed').map(i => i.opportunity);
    if (toImport.length > 0) {
      importOpportunities(toImport, fileName);
    }
    // Archive selected removed to graveyard (instead of hard delete)
    const toRemove = items.filter(i => i.selected && i.changeType === 'removed');
    for (const item of toRemove) {
      archiveToGraveyard(item.opportunity.id, 'Removed from import file');
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
            <button
              onClick={() => setShowUnchanged(!showUnchanged)}
              className="flex items-center gap-1 text-muted-foreground bg-secondary px-2 py-0.5 rounded hover:text-foreground transition-colors cursor-pointer"
            >
              <Minus size={12} /> {counts.unchanged} unchanged {showUnchanged ? '(hide)' : '(show)'}
            </button>
          )}
          {counts.removed > 0 && (
            <button
              onClick={() => setShowRemoved(!showRemoved)}
              className="flex items-center gap-1 text-destructive bg-destructive/10 px-2 py-0.5 rounded hover:text-destructive/80 transition-colors cursor-pointer"
            >
              <Trash2 size={12} /> {counts.removed} removed {showRemoved ? '(hide)' : '(show)'}
            </button>
          )}
          <button
            onClick={handleToggleAllUnmatched}
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors cursor-pointer ${
              showAllUnmatched
                ? 'text-destructive bg-destructive/10 hover:text-destructive/80'
                : 'text-muted-foreground bg-secondary hover:text-foreground'
            }`}
          >
            {showAllUnmatched ? 'All unmatched (on)' : 'Show all unmatched'}
          </button>
        </div>
      </div>

      <div className="flex gap-2 text-xs flex-wrap">
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
        {counts.removed > 0 && (
          <div className="flex gap-1">
            <button onClick={() => selectAll('removed')} className="text-muted-foreground hover:text-destructive underline">Select all removed</button>
            <span className="text-muted-foreground">/</span>
            <button onClick={() => deselectAll('removed')} className="text-muted-foreground hover:text-foreground underline">Deselect</button>
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
            {visibleItems.map(item => (
              <tr
                key={item.opportunity.id}
                onClick={() => toggle(item.opportunity.id)}
                className={`border-b border-border last:border-0 cursor-pointer transition-colors ${
                  item.changeType === 'removed'
                    ? item.selected ? 'bg-destructive/10' : 'opacity-50'
                    : item.selected ? 'bg-secondary/20' : 'opacity-50'
                } hover:bg-secondary/40`}
              >
                <td className="px-3 py-2 text-center">
                  <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                    item.selected
                      ? item.changeType === 'removed'
                        ? 'bg-destructive border-destructive'
                        : 'bg-foreground border-foreground'
                      : 'border-border'
                  }`}>
                    {item.selected && <Check size={10} className="text-background" />}
                  </div>
                </td>
                <td className="px-3 py-2">
                  {item.changeType === 'new' && <span className="text-xs text-positive bg-positive/10 px-1.5 py-0.5 rounded">New</span>}
                  {item.changeType === 'updated' && <span className="text-xs text-upside bg-upside/10 px-1.5 py-0.5 rounded">Updated</span>}
                  {item.changeType === 'unchanged' && <span className="text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">Same</span>}
                  {item.changeType === 'removed' && <span className="text-xs text-destructive bg-destructive/10 px-1.5 py-0.5 rounded">Removed</span>}
                </td>
                <td className={`px-3 py-2 font-medium ${item.changeType === 'removed' ? 'line-through text-muted-foreground' : ''}`}>{item.opportunity.name}</td>
                <td className="px-3 py-2 text-secondary-foreground">{item.opportunity.repName}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(item.opportunity.amount)}</td>
                <td className="px-3 py-2">
                  {item.changes.length > 0 ? (
                    <div className="space-y-0.5">
                      {item.changes.map((c, i) => (
                        <div key={i} className={`text-xs ${item.changeType === 'removed' ? 'text-destructive' : 'text-upside'}`}>{c}</div>
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
        <div className="text-xs text-muted-foreground space-y-0.5">
          <p>{counts.selected} of {items.length} selected</p>
          {counts.removedSelected > 0 && (
            <p className="text-destructive">{counts.removedSelected} will be removed from app</p>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={onCancel} className="px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground border border-border rounded-md transition-colors">
            Cancel
          </button>
          <button
            onClick={handleApprove}
            disabled={counts.selected === 0}
            className="px-4 py-2 text-xs font-medium bg-foreground text-background rounded-md hover:bg-foreground/90 transition-colors disabled:opacity-50"
          >
            Apply {counts.selected} {counts.selected === 1 ? 'change' : 'changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
