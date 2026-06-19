import { useMemo } from 'react';
import type { Opportunity } from '@/types/forecast';
import { getQuarter, type Quarter } from '@/types/forecast';
import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

interface Props {
  opportunities: Opportunity[];
  allOpportunities: Opportunity[];
  totalGoal: number;
  selectedQuarter: Quarter | 'full-year';
  fullYearQuarters: Quarter[];
}

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const coverage = (pipe: number, target: number) => target === 0 ? '—' : (pipe / target).toFixed(2);

export default function PipelineCoverage({ opportunities, allOpportunities, totalGoal, selectedQuarter, fullYearQuarters }: Props) {
  const metrics = useMemo(() => {
    // Active pipeline (excludes closed won and lost)
    const activeOpps = opportunities.filter(o =>
      o.classification !== 'closed_won' && o.classification !== 'lost' && o.classification !== 'omitted' && o.classification !== 'rejected' &&
      o.stage.toLowerCase().trim() !== 'closed lost' && o.stage.toLowerCase().trim() !== 'closed won' && o.stage.toLowerCase().trim() !== 'rejected'
    );

    const closedWon = opportunities.filter(o => o.classification === 'closed_won').reduce((s, o) => s + o.amount, 0);
    const remainingTarget = Math.max(0, totalGoal - closedWon);

    const unweightedPipe = activeOpps.reduce((s, o) => s + o.amount, 0);
    const pipe25 = activeOpps.filter(o => o.probability >= 0.25).reduce((s, o) => s + o.amount, 0);
    const pipe50 = activeOpps.filter(o => o.probability >= 0.5).reduce((s, o) => s + o.amount, 0);

    // Prior quarter open pipe: deals with close dates before the selected period that are still open
    const earliestQuarter = fullYearQuarters[0];
    const priorOpenPipe = allOpportunities.filter(o => {
      if (!o.closeDate) return false;
      if (o.classification === 'closed_won' || o.classification === 'lost' || o.classification === 'rejected' || o.classification === 'omitted') return false;
      const st = o.stage.toLowerCase().trim();
      if (st === 'closed lost' || st === 'closed won' || st === 'rejected') return false;
      const q = getQuarter(o.closeDate);
      return q < earliestQuarter;
    }).reduce((s, o) => s + o.amount, 0);

    return { remainingTarget, closedWon, unweightedPipe, pipe25, pipe50, priorOpenPipe };
  }, [opportunities, allOpportunities, totalGoal, fullYearQuarters]);

  const rows = [
    { label: 'Target (Remaining)', value: metrics.remainingTarget, showCoverage: false },
    { label: 'Unweighted Pipe', value: metrics.unweightedPipe, showCoverage: true },
    { label: '25%+ Unweighted Pipe', value: metrics.pipe25, showCoverage: true },
    { label: '50%+ Unweighted Pipe', value: metrics.pipe50, showCoverage: true },
    { label: 'Prior Qtr Open Pipe', value: metrics.priorOpenPipe, showCoverage: true },
  ];

  return (
    <Collapsible>
      <CollapsibleTrigger className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors group w-full">
        <ChevronDown size={14} className="transition-transform group-data-[state=open]:rotate-180" />
        Pipeline Coverage Analysis
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-3 border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Metric</th>
                <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {selectedQuarter === 'full-year' ? 'Full Year' : selectedQuarter} Total
                </th>
                <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Coverage</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.label} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 text-xs font-medium">{r.label}</td>
                  <td className="text-right px-4 py-2 font-mono text-xs">{fmt(r.value)}</td>
                  <td className="text-right px-4 py-2 font-mono text-xs font-semibold">
                    {r.showCoverage ? coverage(r.value, metrics.remainingTarget) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
