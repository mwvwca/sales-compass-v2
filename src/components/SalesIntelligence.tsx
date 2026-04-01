import { useMemo, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import type { Opportunity, OpportunitySnapshot, Quarter } from '@/types/forecast';
import { getQuarter, getCurrentQuarter, getQuarterMonths } from '@/types/forecast';
import { getStagePercentage } from '@/lib/utils';
import { AlertTriangle, TrendingUp, TrendingDown, Target, ChevronDown, ChevronRight, Calendar } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

interface Props {
  opportunities: Opportunity[];
  selectedQuarter: Quarter | 'full-year';
  selectedRep: string | 'all';
}

interface RiskFlag {
  oppId: string;
  oppName: string;
  repName: string;
  level: 'high' | 'medium' | 'low';
  reasons: string[];
}

interface WinLossStat {
  repName: string;
  won: number;
  lost: number;
  winRate: number;
  avgWonSize: number;
  avgLostSize: number;
  avgDaysToClose: number | null;
}

interface PipelineRec {
  type: 'warning' | 'info' | 'positive';
  message: string;
}

export default function SalesIntelligence({ opportunities, selectedQuarter, selectedRep }: Props) {
  const { snapshots } = useForecast();
  const [open, setOpen] = useState(false);

  const currentQuarter = getCurrentQuarter();

  const allOpps = opportunities;
  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  // ─── Deal Risk Scoring ───
  const riskFlags = useMemo((): RiskFlag[] => {
    const flags: RiskFlag[] = [];
    const now = new Date();

    for (const opp of allOpps) {
      if (opp.classification === 'closed_won' || opp.classification === 'lost') continue;
      const reasons: string[] = [];

      // 1. Close date in the past
      const closeDate = new Date(opp.closeDate);
      if (closeDate < now) {
        reasons.push('Close date has passed');
      }

      // 2. Close date slipping (check snapshots)
      const history = snapshots
        .filter(s => s.opportunityId === opp.id)
        .sort((a, b) => new Date(a.importDate).getTime() - new Date(b.importDate).getTime());
      
      const dateSlips = history.reduce((count, snap, i) => {
        if (i === 0) return 0;
        const prev = new Date(history[i - 1].closeDate);
        const curr = new Date(snap.closeDate);
        return curr > prev ? count + 1 : count;
      }, 0);
      
      if (dateSlips >= 2) {
        reasons.push(`Close date pushed ${dateSlips} times`);
      }

      // 3. Amount decreased
      if (history.length >= 2) {
        const first = history[0].amount;
        const last = history[history.length - 1].amount;
        if (last < first * 0.8) {
          reasons.push(`Amount decreased ${Math.round((1 - last / first) * 100)}% since first import`);
        }
      }

      // 4. Low probability with near close date
      const daysToClose = Math.ceil((closeDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      const stagePct = getStagePercentage(opp.stage);
      if (stagePct !== null && stagePct < 50 && daysToClose <= 30 && daysToClose > 0) {
        reasons.push(`Only ${stagePct}% stage with ${daysToClose} days to close`);
      }

      // 5. Stage hasn't advanced across imports
      if (history.length >= 3) {
        const stages = history.map(h => h.stage);
        const uniqueStages = new Set(stages);
        if (uniqueStages.size === 1) {
          reasons.push(`Stage unchanged across ${history.length} imports`);
        }
      }

      if (reasons.length > 0) {
        const level = reasons.length >= 3 ? 'high' : reasons.length >= 2 ? 'medium' : 'low';
        flags.push({ oppId: opp.id, oppName: opp.name, repName: opp.repName, level, reasons });
      }
    }

    return flags.sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return order[a.level] - order[b.level];
    });
  }, [allOpps, snapshots]);

  // ─── Win/Loss Pattern Analysis ───
  const winLossStats = useMemo((): WinLossStat[] => {
    const allWithLost = [...allOpps];
    const repMap = new Map<string, { won: Opportunity[]; lost: Opportunity[] }>();

    for (const opp of allWithLost) {
      const entry = repMap.get(opp.repName) || { won: [], lost: [] };
      if (opp.classification === 'closed_won') entry.won.push(opp);
      else if (opp.classification === 'lost') entry.lost.push(opp);
      repMap.set(opp.repName, entry);
    }

    return Array.from(repMap.entries()).map(([repName, { won, lost }]) => {
      const total = won.length + lost.length;
      const avgWonSize = won.length > 0 ? won.reduce((s, o) => s + o.amount, 0) / won.length : 0;
      const avgLostSize = lost.length > 0 ? lost.reduce((s, o) => s + o.amount, 0) / lost.length : 0;

      // Average days to close for won deals (from first snapshot to close)
      let avgDays: number | null = null;
      const daysArr: number[] = [];
      for (const o of won) {
        const hist = snapshots.filter(s => s.opportunityId === o.id).sort((a, b) => new Date(a.importDate).getTime() - new Date(b.importDate).getTime());
        if (hist.length > 0) {
          const firstSeen = new Date(hist[0].importDate);
          const closed = new Date(o.closeDate);
          daysArr.push(Math.max(0, Math.ceil((closed.getTime() - firstSeen.getTime()) / (1000 * 60 * 60 * 24))));
        }
      }
      if (daysArr.length > 0) avgDays = Math.round(daysArr.reduce((s, d) => s + d, 0) / daysArr.length);

      return {
        repName,
        won: won.length,
        lost: lost.length,
        winRate: total > 0 ? (won.length / total) * 100 : 0,
        avgWonSize,
        avgLostSize,
        avgDaysToClose: avgDays,
      };
    }).sort((a, b) => b.winRate - a.winRate);
  }, [allOpps, snapshots]);

  // ─── Pipeline Health Recommendations ───
  const recommendations = useMemo((): PipelineRec[] => {
    const recs: PipelineRec[] = [];
    const activeOpps = allOpps.filter(o => o.classification !== 'closed_won' && o.classification !== 'lost' && o.classification !== 'omitted');

    // Check coverage per rep
    for (const stat of winLossStats) {
      if (stat.winRate > 0 && stat.winRate < 30) {
        recs.push({ type: 'warning', message: `${stat.repName} has a low win rate (${stat.winRate.toFixed(0)}%). Review deal qualification.` });
      }
      if (stat.winRate >= 60) {
        recs.push({ type: 'positive', message: `${stat.repName} has a strong win rate (${stat.winRate.toFixed(0)}%).` });
      }
    }

    // Early-stage heavy pipe
    const earlyStage = activeOpps.filter(o => {
      const pct = getStagePercentage(o.stage);
      return pct !== null && pct <= 25;
    });
    const lateStage = activeOpps.filter(o => {
      const pct = getStagePercentage(o.stage);
      return pct !== null && pct >= 50;
    });
    if (earlyStage.length > lateStage.length * 2 && activeOpps.length > 3) {
      recs.push({ type: 'warning', message: `Pipeline is early-stage heavy (${earlyStage.length} early vs ${lateStage.length} late-stage). Push deals forward.` });
    }

    // Deals with past close dates
    const now = new Date();
    const pastDue = activeOpps.filter(o => new Date(o.closeDate) < now);
    if (pastDue.length > 0) {
      const totalPastDue = pastDue.reduce((s, o) => s + o.amount, 0);
      recs.push({ type: 'warning', message: `${pastDue.length} deals (${fmt(totalPastDue)}) have close dates in the past. Update or remove.` });
    }

    // Concentration risk
    if (activeOpps.length > 0) {
      const sorted = [...activeOpps].sort((a, b) => b.amount - a.amount);
      const totalPipe = activeOpps.reduce((s, o) => s + o.amount, 0);
      if (sorted[0] && sorted[0].amount > totalPipe * 0.4) {
        recs.push({ type: 'warning', message: `"${sorted[0].name}" is ${Math.round((sorted[0].amount / totalPipe) * 100)}% of active pipeline. High concentration risk.` });
      }
    }

    // High risk deals
    const highRisk = riskFlags.filter(f => f.level === 'high');
    if (highRisk.length > 0) {
      recs.push({ type: 'warning', message: `${highRisk.length} deal(s) flagged as high risk. Review immediately.` });
    }

    if (recs.length === 0) {
      recs.push({ type: 'positive', message: 'Pipeline looks healthy. No major issues detected.' });
    }

    return recs;
  }, [allOpps, winLossStats, riskFlags]);

  // ─── Close Date Prediction ───
  const closeDatePredictions = useMemo(() => {
    const activeOpps = allOpps.filter(o => o.classification !== 'closed_won' && o.classification !== 'lost' && o.classification !== 'omitted');
    
    // Calculate avg days per stage from won deals
    const stageTimings = new Map<string, number[]>();
    const wonOpps = allOpps.filter(o => o.classification === 'closed_won');
    
    for (const opp of wonOpps) {
      const hist = snapshots
        .filter(s => s.opportunityId === opp.id)
        .sort((a, b) => new Date(a.importDate).getTime() - new Date(b.importDate).getTime());
      
      if (hist.length >= 2) {
        const firstSeen = new Date(hist[0].importDate);
        const closeDate = new Date(opp.closeDate);
        const totalDays = Math.max(1, Math.ceil((closeDate.getTime() - firstSeen.getTime()) / (1000 * 60 * 60 * 24)));
        const stage = hist[0].stage.toLowerCase().trim();
        const arr = stageTimings.get(stage) || [];
        arr.push(totalDays);
        stageTimings.set(stage, arr);
      }
    }

    const avgByStage = new Map<string, number>();
    for (const [stage, days] of stageTimings) {
      avgByStage.set(stage, Math.round(days.reduce((s, d) => s + d, 0) / days.length));
    }

    return activeOpps.slice(0, 10).map(opp => {
      const hist = snapshots
        .filter(s => s.opportunityId === opp.id)
        .sort((a, b) => new Date(a.importDate).getTime() - new Date(b.importDate).getTime());
      
      const firstSeen = hist.length > 0 ? new Date(hist[0].importDate) : new Date(opp.importDate);
      const stagePct = getStagePercentage(opp.stage) || 0;
      
      // Estimate: if we know avg days from this stage to close, use it
      const stageKey = opp.stage.toLowerCase().trim();
      const avgDays = avgByStage.get(stageKey);
      
      let predictedDate: Date;
      if (avgDays) {
        const remaining = Math.round(avgDays * (1 - stagePct / 100));
        predictedDate = new Date();
        predictedDate.setDate(predictedDate.getDate() + remaining);
      } else {
        // Fallback: use stage percentage to estimate
        const daysSoFar = Math.ceil((Date.now() - firstSeen.getTime()) / (1000 * 60 * 60 * 24));
        const estimatedTotal = stagePct > 0 ? Math.round(daysSoFar / (stagePct / 100)) : daysSoFar + 90;
        const remaining = Math.max(0, estimatedTotal - daysSoFar);
        predictedDate = new Date();
        predictedDate.setDate(predictedDate.getDate() + remaining);
      }

      const stated = new Date(opp.closeDate);
      const diffDays = Math.round((predictedDate.getTime() - stated.getTime()) / (1000 * 60 * 60 * 24));

      return {
        id: opp.id,
        name: opp.name,
        repName: opp.repName,
        statedClose: opp.closeDate,
        predictedClose: predictedDate.toISOString().split('T')[0],
        diffDays,
        confidence: avgDays ? 'historical' : 'estimated',
      };
    });
  }, [allOpps, snapshots]);


  const levelColors = {
    high: 'text-negative bg-negative/10 border-negative/30',
    medium: 'text-upside bg-upside/10 border-upside/30',
    low: 'text-muted-foreground bg-secondary border-border',
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 w-full text-left py-2 px-1 hover:bg-secondary/30 rounded transition-colors">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sales Intelligence</span>
        {!open && riskFlags.filter(f => f.level === 'high').length > 0 && (
          <span className="text-xs bg-negative/20 text-negative px-1.5 py-0.5 rounded-full">
            {riskFlags.filter(f => f.level === 'high').length} high risk
          </span>
        )}
      </CollapsibleTrigger>

      <CollapsibleContent className="space-y-4 mt-2">
        {/* Pipeline Health Recommendations */}
        <div className="border border-border rounded-lg p-4">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
            <Target size={12} /> Pipeline Health
          </h4>
          <div className="space-y-2">
            {recommendations.map((rec, i) => (
              <div key={i} className={`flex items-start gap-2 text-xs px-3 py-2 rounded border ${
                rec.type === 'warning' ? 'bg-upside/5 border-upside/20 text-upside' :
                rec.type === 'positive' ? 'bg-positive/5 border-positive/20 text-positive' :
                'bg-secondary border-border text-foreground'
              }`}>
                {rec.type === 'warning' ? <AlertTriangle size={12} className="mt-0.5 shrink-0" /> : <TrendingUp size={12} className="mt-0.5 shrink-0" />}
                <span>{rec.message}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Deal Risk Scoring */}
        {riskFlags.length > 0 && (
          <div className="border border-border rounded-lg p-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
              <AlertTriangle size={12} /> Deal Risk Flags ({riskFlags.length})
            </h4>
            <div className="space-y-2">
              {riskFlags.map(flag => (
                <div key={flag.oppId} className={`px-3 py-2 rounded border text-xs ${levelColors[flag.level]}`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium">{flag.oppName}</span>
                    <span className="text-[10px] uppercase font-semibold">{flag.level} risk</span>
                  </div>
                  <div className="text-[11px] opacity-80">
                    {flag.repName} — {flag.reasons.join(' · ')}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Win/Loss Patterns */}
        {winLossStats.length > 0 && (
          <div className="border border-border rounded-lg p-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
              <TrendingDown size={12} /> Win/Loss Analysis
            </h4>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-1.5 text-muted-foreground font-medium">Rep</th>
                  <th className="text-center py-1.5 text-muted-foreground font-medium">Won</th>
                  <th className="text-center py-1.5 text-muted-foreground font-medium">Lost</th>
                  <th className="text-center py-1.5 text-muted-foreground font-medium">Win Rate</th>
                  <th className="text-right py-1.5 text-muted-foreground font-medium">Avg Won</th>
                  <th className="text-right py-1.5 text-muted-foreground font-medium">Avg Lost</th>
                  <th className="text-right py-1.5 text-muted-foreground font-medium">Avg Days</th>
                </tr>
              </thead>
              <tbody>
                {winLossStats.map(stat => (
                  <tr key={stat.repName} className="border-b border-border last:border-0">
                    <td className="py-1.5 font-medium">{stat.repName}</td>
                    <td className="text-center py-1.5 text-positive font-mono">{stat.won}</td>
                    <td className="text-center py-1.5 text-negative font-mono">{stat.lost}</td>
                    <td className="text-center py-1.5">
                      <span className={`font-mono font-semibold ${stat.winRate >= 50 ? 'text-positive' : stat.winRate >= 30 ? 'text-upside' : 'text-negative'}`}>
                        {stat.winRate.toFixed(0)}%
                      </span>
                    </td>
                    <td className="text-right py-1.5 font-mono">{stat.avgWonSize > 0 ? fmt(stat.avgWonSize) : '—'}</td>
                    <td className="text-right py-1.5 font-mono">{stat.avgLostSize > 0 ? fmt(stat.avgLostSize) : '—'}</td>
                    <td className="text-right py-1.5 font-mono">{stat.avgDaysToClose !== null ? `${stat.avgDaysToClose}d` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Close Date Predictions */}
        {closeDatePredictions.length > 0 && (
          <div className="border border-border rounded-lg p-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
              <Calendar size={12} /> Close Date Predictions
            </h4>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-1.5 text-muted-foreground font-medium">Opportunity</th>
                  <th className="text-left py-1.5 text-muted-foreground font-medium">Rep</th>
                  <th className="text-center py-1.5 text-muted-foreground font-medium">Stated Close</th>
                  <th className="text-center py-1.5 text-muted-foreground font-medium">Predicted</th>
                  <th className="text-center py-1.5 text-muted-foreground font-medium">Δ Days</th>
                </tr>
              </thead>
              <tbody>
                {closeDatePredictions.map(p => (
                  <tr key={p.id} className="border-b border-border last:border-0">
                    <td className="py-1.5 font-medium max-w-[200px] truncate">{p.name}</td>
                    <td className="py-1.5 text-secondary-foreground">{p.repName}</td>
                    <td className="text-center py-1.5 font-mono">{p.statedClose}</td>
                    <td className="text-center py-1.5 font-mono">{p.predictedClose}</td>
                    <td className={`text-center py-1.5 font-mono font-semibold ${
                      p.diffDays > 14 ? 'text-negative' : p.diffDays > 0 ? 'text-upside' : 'text-positive'
                    }`}>
                      {p.diffDays > 0 ? `+${p.diffDays}` : p.diffDays}
                      <span className="text-[10px] text-muted-foreground ml-1">
                        ({p.confidence === 'historical' ? 'hist' : 'est'})
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[10px] text-muted-foreground mt-2">
              hist = based on historical win data · est = estimated from stage progression
            </p>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
