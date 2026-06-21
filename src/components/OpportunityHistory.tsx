import { useForecast } from '@/context/ForecastContext';
import type { OpportunitySnapshot } from '@/types/forecast';
import { X, TrendingUp, TrendingDown, Minus, Calendar, DollarSign, Layers } from 'lucide-react';

interface Props {
  opportunityId: string;
  opportunityName: string;
  onClose: () => void;
}

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function HealthIndicator({ snapshots }: { snapshots: OpportunitySnapshot[] }) {
  if (snapshots.length < 2) return <span className="text-xs text-muted-foreground">Insufficient data</span>;

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const amountDelta = last.amount - first.amount;
  const closeDateMoved = first.closeDate !== last.closeDate;
  const stageDiffers = first.stage !== last.stage;

  const signals: { icon: React.ReactNode; label: string; color: string }[] = [];

  if (amountDelta > 0) signals.push({ icon: <TrendingUp size={12} />, label: `Amount up ${fmt(amountDelta)}`, color: 'text-positive' });
  else if (amountDelta < 0) signals.push({ icon: <TrendingDown size={12} />, label: `Amount down ${fmt(Math.abs(amountDelta))}`, color: 'text-negative' });
  else signals.push({ icon: <Minus size={12} />, label: 'Amount stable', color: 'text-muted-foreground' });

  if (closeDateMoved) {
    const firstDate = new Date(first.closeDate).getTime();
    const lastDate = new Date(last.closeDate).getTime();
    signals.push({
      icon: <Calendar size={12} />,
      label: lastDate > firstDate ? 'Close date pushed out' : 'Close date pulled in',
      color: lastDate > firstDate ? 'text-negative' : 'text-positive',
    });
  }

  if (stageDiffers) signals.push({ icon: <Layers size={12} />, label: `Stage: ${first.stage} → ${last.stage}`, color: 'text-upside' });

  return (
    <div className="flex flex-wrap gap-3">
      {signals.map((s, i) => (
        <span key={i} className={`flex items-center gap-1 text-xs ${s.color}`}>
          {s.icon} {s.label}
        </span>
      ))}
    </div>
  );
}

export default function OpportunityHistory({ opportunityId, opportunityName, onClose }: Props) {
  const { getOpportunityHistory, changelog } = useForecast();
  const snapshots = getOpportunityHistory(opportunityId);
  const oppChangelog = changelog
    .filter(c => c.opportunityId === opportunityId)
    .sort((a, b) => new Date(b.importDate).getTime() - new Date(a.importDate).getTime());

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-lg w-full max-w-2xl max-h-[80vh] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">{opportunityName} — History</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors"><X size={16} /></button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto max-h-[calc(80vh-3.5rem)]">
          {/* Health summary */}
          <div className="bg-secondary/50 rounded-lg p-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Health Indicators</p>
            <HealthIndicator snapshots={snapshots} />
          </div>

          {/* Snapshot timeline */}
          {snapshots.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Import Snapshots ({snapshots.length})</p>
              <div className="border border-border rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-secondary/50">
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground uppercase tracking-wider">Date</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground uppercase tracking-wider">Amount</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground uppercase tracking-wider">Close</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground uppercase tracking-wider">Stage</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground uppercase tracking-wider">Class</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...snapshots].reverse().map((snap, i) => {
                      const prev = snapshots[snapshots.length - 2 - i]; // previous in chronological order
                      const amtChanged = prev && prev.amount !== snap.amount;
                      const dateChanged = prev && prev.closeDate !== snap.closeDate;
                      const stageChanged = prev && prev.stage !== snap.stage;
                      const date = new Date(snap.importDate);
                      return (
                        <tr key={i} className="border-b border-border last:border-0 hover:bg-secondary/30">
                          <td className="px-3 py-2 font-mono text-muted-foreground">
                            {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </td>
                          <td className={`px-3 py-2 text-right font-mono ${amtChanged ? 'text-upside font-semibold' : ''}`}>
                            {fmt(snap.amount)}
                          </td>
                          <td className={`px-3 py-2 font-mono ${dateChanged ? 'text-upside font-semibold' : ''}`}>
                            {snap.closeDate}
                          </td>
                          <td className={`px-3 py-2 ${stageChanged ? 'text-upside font-semibold' : ''}`}>
                            {snap.stage}
                          </td>
                          <td className="px-3 py-2">
                            <ClassBadge cls={snap.classification} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </div>
            </div>
          )}

          {/* Field changelog */}
          {oppChangelog.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Change Log ({oppChangelog.length})</p>
              <div className="space-y-1">
                {oppChangelog.map(entry => {
                  const date = new Date(entry.importDate);
                  const fieldColors: Record<string, string> = {
                    amount: 'bg-commit/10 text-commit',
                    closeDate: 'bg-upside/10 text-upside',
                    stage: 'bg-positive/10 text-positive',
                    classification: 'bg-secondary text-foreground',
                    name: 'bg-secondary text-muted-foreground',
                    repName: 'bg-secondary text-muted-foreground',
                  };
                  return (
                    <div key={entry.id} className="flex items-center gap-2 text-xs py-1 px-2 rounded hover:bg-secondary/30">
                      <span className="font-mono text-muted-foreground w-28 shrink-0">
                        {date.toLocaleDateString()}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded text-xs ${fieldColors[entry.field] || 'bg-secondary text-muted-foreground'}`}>
                        {entry.field}
                      </span>
                      <span className="text-negative font-mono">{entry.field === 'amount' ? fmt(Number(entry.oldValue)) : entry.oldValue}</span>
                      <span className="text-muted-foreground">→</span>
                      <span className="text-positive font-mono">{entry.field === 'amount' ? fmt(Number(entry.newValue)) : entry.newValue}</span>
                      <span className="text-muted-foreground ml-auto">{entry.fileName}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {snapshots.length === 0 && oppChangelog.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-6">No history recorded yet. Import data to start tracking changes.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function ClassBadge({ cls }: { cls: string }) {
  const colors: Record<string, string> = {
    closed_won: 'bg-positive/20 text-positive',
    commit: 'bg-commit/20 text-commit',
    upside: 'bg-upside/20 text-upside',
    unclassified: 'bg-secondary text-muted-foreground',
  };
  const labels: Record<string, string> = { closed_won: 'Won', commit: 'Commit', upside: 'Upside', unclassified: '—' };
  return <span className={`px-1.5 py-0.5 rounded text-xs ${colors[cls] || 'bg-secondary text-muted-foreground'}`}>{labels[cls] || cls}</span>;
}
