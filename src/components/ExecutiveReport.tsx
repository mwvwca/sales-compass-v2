import { useMemo, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { getQuarter, getMonthKey, getMonthLabel, getQuarterMonths, getCurrentQuarter, type Quarter } from '@/types/forecast';
import { Copy, Check, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { toast } from 'sonner';

export default function ExecutiveReport() {
  const { reps, opportunities } = useForecast();
  const [copied, setCopied] = useState(false);

  const quarter = getCurrentQuarter();
  const months = getQuarterMonths(quarter);

  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const pct = (n: number, d: number) => d === 0 ? 'N/A' : `${Math.round((n / d) * 100)}%`;

  const report = useMemo(() => {
    const qOpps = opportunities.filter(o => o.closeDate && getQuarter(o.closeDate) === quarter);

    const totalGoal = reps.reduce((s, r) => s + (r.quarterlyGoals[quarter] || 0), 0);
    const closedWon = qOpps.filter(o => o.classification === 'closed_won').reduce((s, o) => s + o.amount, 0);
    const commit = qOpps.filter(o => o.classification === 'commit').reduce((s, o) => s + o.amount, 0);
    const upside = qOpps.filter(o => o.classification === 'upside').reduce((s, o) => s + o.amount, 0);
    const totalPipe = qOpps.reduce((s, o) => s + o.amount, 0);
    const variance = closedWon - totalGoal;

    // Monthly breakdown
    const monthly = months.map(m => {
      const mOpps = qOpps.filter(o => getMonthKey(o.closeDate) === m);
      return {
        label: getMonthLabel(m),
        closedWon: mOpps.filter(o => o.classification === 'closed_won').reduce((s, o) => s + o.amount, 0),
        commit: mOpps.filter(o => o.classification === 'commit').reduce((s, o) => s + o.amount, 0),
        upside: mOpps.filter(o => o.classification === 'upside').reduce((s, o) => s + o.amount, 0),
      };
    });



    // Build plain text
    const lines: string[] = [];
    lines.push(`${quarter} Forecast Summary`);
    lines.push('─'.repeat(35));
    lines.push('');
    lines.push(`Quarterly Goal:    ${fmt(totalGoal)}`);
    lines.push(`Closed Won:        ${fmt(closedWon)}  (${pct(closedWon, totalGoal)} of goal)`);
    lines.push(`Commit:            ${fmt(commit)}  (${pct(commit, totalGoal)} of goal)`);
    lines.push(`Upside:            ${fmt(upside)}`);
    lines.push(`Total Pipeline:    ${fmt(totalPipe)}`);
    lines.push(`Variance:          ${fmt(variance)}`);
    lines.push('');

    lines.push('Monthly Breakdown');
    lines.push('─'.repeat(35));
    for (const m of monthly) {
      const parts: string[] = [];
      if (m.closedWon > 0) parts.push(`Won ${fmt(m.closedWon)}`);
      if (m.commit > 0) parts.push(`Commit ${fmt(m.commit)}`);
      if (m.upside > 0) parts.push(`Upside ${fmt(m.upside)}`);
      lines.push(`  ${m.label.padEnd(10)} ${parts.length > 0 ? parts.join(' · ') : '—'}`);
    }
    lines.push('');

    const wonDeals = qOpps.filter(o => o.classification === 'closed_won').sort((a, b) => b.amount - a.amount).slice(0, 5);
    const commitDeals = qOpps.filter(o => o.classification === 'commit').sort((a, b) => b.amount - a.amount);

    if (wonDeals.length > 0) {
      lines.push('Closed Won');
      lines.push('─'.repeat(35));
      for (const d of wonDeals) {
        lines.push(`  ${fmt(d.amount).padEnd(12)} ${d.name} (${d.repName})`);
      }
      lines.push('');
    }

    if (commitDeals.length > 0) {
      lines.push('Commit Deals');
      lines.push('─'.repeat(35));
      for (const d of commitDeals) {
        const close = new Date(d.closeDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        lines.push(`  ${fmt(d.amount).padEnd(12)} ${close.padEnd(8)} ${d.name} (${d.repName})`);
      }
      lines.push('');
    }

    // Rep summary
    const repNames = Array.from(new Set(qOpps.map(o => o.repName))).sort();
    if (repNames.length > 0) {
      lines.push('Rep Summary');
      lines.push('─'.repeat(35));
      for (const name of repNames) {
        const rOpps = qOpps.filter(o => o.repName === name);
        const rWon = rOpps.filter(o => o.classification === 'closed_won').reduce((s, o) => s + o.amount, 0);
        const rWonCount = rOpps.filter(o => o.classification === 'closed_won').length;
        const rCommit = rOpps.filter(o => o.classification === 'commit').reduce((s, o) => s + o.amount, 0);
        const rTotal = rOpps.reduce((s, o) => s + o.amount, 0);
        const rConv = rTotal > 0 ? `${Math.round((rWon / rTotal) * 100)}%` : 'N/A';
        const rAsp = rWonCount > 0 ? fmt(rWon / rWonCount) : 'N/A';
        const parts: string[] = [];
        if (rWon > 0) parts.push(`Won ${fmt(rWon)}`);
        if (rCommit > 0) parts.push(`Commit ${fmt(rCommit)}`);
        parts.push(`Conv ${rConv}`);
        parts.push(`ASP ${rAsp}`);
        lines.push(`  ${name.padEnd(18)} ${parts.join(' · ')}`);
      }
    }

    return lines.join('\n');
  }, [opportunities, reps, quarter, months]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(report);
    setCopied(true);
    toast.success('Report copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 text-xs">
          <FileText size={14} />
          Exec Report
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>Executive Summary</span>
            <Button variant="outline" size="sm" onClick={handleCopy} className="gap-1.5 text-xs">
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copied' : 'Copy to clipboard'}
            </Button>
          </DialogTitle>
        </DialogHeader>
        <pre className="bg-secondary rounded-lg p-4 text-xs font-mono whitespace-pre-wrap overflow-auto max-h-[60vh] text-foreground leading-relaxed">
          {report}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
