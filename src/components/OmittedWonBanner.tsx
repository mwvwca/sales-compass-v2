import { useMemo, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { Button } from '@/components/ui/button';
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/**
 * F3 fix: `omitted` is deliberately sticky (a test deal stays omitted even
 * when Salesforce closes it Won), but that made real won revenue silently
 * invisible: the deal is Closed Won in Salesforce and counts nowhere here.
 * This banner surfaces the contradiction and makes the resolution an explicit
 * user decision per deal instead of a silent merge rule.
 */
export default function OmittedWonBanner() {
  const { opportunities, classifyOpportunity, updateOpportunity } = useForecast();
  const [expanded, setExpanded] = useState(false);

  const conflicted = useMemo(() => opportunities.filter(o => {
    if (o.classification !== 'omitted' || o.omittedWonAck) return false;
    const stageNorm = (o.stage || '').toLowerCase().trim().replace(/[-_/]/g, ' ').replace(/\s+/g, ' ');
    return stageNorm === 'closed won';
  }), [opportunities]);

  if (conflicted.length === 0) return null;

  const total = conflicted.reduce((a, o) => a + o.amount, 0);

  return (
    <div className="mb-4 border border-amber-500/40 bg-amber-500/10 rounded-md text-xs">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-left"
      >
        <span className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
          <AlertTriangle size={13} />
          {conflicted.length} deal{conflicted.length === 1 ? '' : 's'} ({fmt(total)}) closed Won in Salesforce but omitted here and counted nowhere
        </span>
        {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {expanded && (
        <div className="border-t border-amber-500/30 divide-y divide-amber-500/20">
          {conflicted.map(o => (
            <div key={o.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{o.name}</p>
                <p className="text-muted-foreground">{o.repName} · {fmt(o.amount)} · closed {o.closeDate || 'n/a'}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button size="sm" className="h-6 text-xs px-2" onClick={() => classifyOpportunity(o.id, 'closed_won')}>
                  Count as won
                </Button>
                <Button size="sm" variant="outline" className="h-6 text-xs px-2" onClick={() => updateOpportunity(o.id, { omittedWonAck: true })}>
                  Keep omitted
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
