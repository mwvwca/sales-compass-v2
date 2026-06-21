import { useForecast } from '@/context/ForecastContext';
import { Trash2 } from 'lucide-react';

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export default function ImportChangeLog() {
  const { changelog, clearChangelog } = useForecast();

  if (changelog.length === 0) {
    return (
      <div className="text-xs text-muted-foreground mt-6">
        No close date or amount changes logged yet. Changes will appear here after importing updated data.
      </div>
    );
  }

  // Group by import date + fileName
  const grouped = changelog.reduce<Record<string, typeof changelog>>((acc, entry) => {
    const key = `${entry.importDate}__${entry.fileName}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(entry);
    return acc;
  }, {});

  const sortedKeys = Object.keys(grouped).sort().reverse();

  return (
    <div className="mt-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Change Log ({changelog.length} changes)
        </h3>
        <button
          onClick={clearChangelog}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-negative transition-colors"
        >
          <Trash2 size={12} /> Clear log
        </button>
      </div>

      {sortedKeys.map(key => {
        const entries = grouped[key];
        const first = entries[0];
        const date = new Date(first.importDate);
        const label = `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

        return (
          <div key={key} className="border border-border rounded-lg overflow-hidden">
            <div className="bg-secondary/50 px-4 py-2 flex items-center justify-between">
              <span className="text-xs font-medium">{first.fileName}</span>
              <span className="text-xs text-muted-foreground font-mono">{label}</span>
            </div>
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Opportunity</th>
                  <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Rep</th>
                  <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Field</th>
                  <th className="text-right px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Old</th>
                  <th className="text-center px-1 py-1.5 text-xs text-muted-foreground">→</th>
                  <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">New</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(entry => (
                  <tr key={entry.id} className="border-b border-border last:border-0 hover:bg-secondary/30 transition-colors">
                    <td className="px-4 py-2 font-medium">{entry.opportunityName}</td>
                    <td className="px-3 py-2 text-secondary-foreground">{entry.repName}</td>
                    <td className="px-3 py-2">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        entry.field === 'amount' ? 'bg-commit/10 text-commit'
                        : entry.field === 'closeDate' ? 'bg-upside/10 text-upside'
                        : entry.field === 'stage' ? 'bg-positive/10 text-positive'
                        : entry.field === 'classification' ? 'bg-secondary text-foreground'
                        : 'bg-secondary text-muted-foreground'
                      }`}>
                        {entry.field === 'amount' ? 'Amount' : entry.field === 'closeDate' ? 'Close Date' : entry.field === 'classification' ? 'Classification' : entry.field === 'stage' ? 'Stage' : entry.field}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-negative text-xs">
                      {entry.field === 'amount' ? fmt(Number(entry.oldValue)) : entry.oldValue}
                    </td>
                    <td className="px-1 py-2 text-center text-muted-foreground text-xs">→</td>
                    <td className="px-3 py-2 font-mono text-positive text-xs">
                      {entry.field === 'amount' ? fmt(Number(entry.newValue)) : entry.newValue}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
