import { useMemo } from 'react';
import { LineChart, Line, ResponsiveContainer } from 'recharts';
import type { OpportunitySnapshot, Quarter } from '@/types/forecast';
import { getQuarter, quarterStart, getISOWeekRange } from '@/types/forecast';

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function coverageTone(pct: number): string {
  if (pct >= 1.5) return 'text-positive';
  if (pct >= 1.0) return 'text-upside';
  return 'text-negative';
}

export default function CoverageTrendCard({
  snapshots,
  quarter,
  goal,
  selectedRep,
}: {
  snapshots: OpportunitySnapshot[];
  quarter: Quarter;
  goal: number;
  selectedRep: string | 'all';
}) {
  const history = useMemo(() => {
    const closedOrInactive = new Set(['closed_won', 'lost', 'omitted']);
    const inQuarter = snapshots.filter(s => {
      if (selectedRep !== 'all' && s.repName !== selectedRep) return false;
      if (!s.closeDate) return false;
      if (getQuarter(s.closeDate) !== quarter) return false;
      if (closedOrInactive.has(s.classification)) return false;
      return true;
    });

    if (inQuarter.length === 0) return [];

    const qStart = quarterStart(quarter);
    const qStartWeek = getISOWeekRange(qStart);
    const firstMonday = qStartWeek.start;

    // Find the latest import date in each ISO week
    const latestImportByWeek = new Map<number, string>();
    for (const s of inQuarter) {
      const importDateStr = s.importDate.slice(0, 10);
      const importDateObj = new Date(s.importDate);
      const weekStart = getISOWeekRange(importDateObj).start;

      const diffDays = (weekStart.getTime() - firstMonday.getTime()) / (1000 * 60 * 60 * 24);
      const weekNum = Math.round(diffDays / 7) + 1;

      const existing = latestImportByWeek.get(weekNum);
      if (!existing || importDateStr > existing) {
        latestImportByWeek.set(weekNum, importDateStr);
      }
    }

    const history: { date: string; coverage: number; total: number }[] = [];
    for (const [weekNum, latestImport] of latestImportByWeek.entries()) {
      const total = inQuarter
        .filter(s => s.importDate.slice(0, 10) === latestImport)
        .reduce((sum, s) => sum + (s.amount || 0), 0);
      history.push({
        date: `W${weekNum}`,
        coverage: goal > 0 ? total / goal : 0,
        total,
      });
    }

    history.sort((a, b) => {
      const aNum = parseInt(a.date.slice(1));
      const bNum = parseInt(b.date.slice(1));
      return aNum - bNum;
    });

    return history;
  }, [snapshots, quarter, goal, selectedRep]);

  const current = history[history.length - 1];
  const prev = history[history.length - 2];
  const last7 = history.slice(-7);

  if (history.length === 0) {
    return (
      <div className="bg-card border border-border rounded-lg p-4">
        <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Coverage Trend</p>
        <p className="text-xl font-mono font-semibold text-muted-foreground">—</p>
        <p className="text-[10px] font-mono mt-0.5 text-muted-foreground">No snapshots this quarter</p>
      </div>
    );
  }

  const currentPct = current.coverage;
  const colorClass = coverageTone(currentPct);
  const deltaPP = prev ? Math.round((current.coverage - prev.coverage) * 100) : null;
  const trendUp = deltaPP !== null && deltaPP >= 0;
  const lineColor = trendUp ? 'hsl(var(--positive, 142 70% 45%))' : 'hsl(var(--destructive))';

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Coverage Trend</p>
      <div className="flex items-center justify-between gap-2">
        <p className={`text-xl font-mono font-semibold ${colorClass}`}>
          {Math.round(currentPct * 100)}%
        </p>
        {last7.length > 1 && (
          <div style={{ width: 80, height: 32 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={last7}>
                <Line
                  type="monotone"
                  dataKey="coverage"
                  stroke={lineColor}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
      {deltaPP === null ? (
        <p className="text-[10px] font-mono mt-0.5 text-muted-foreground">First import this quarter</p>
      ) : (
        <p className={`text-[10px] font-mono mt-0.5 ${trendUp ? 'text-positive' : 'text-negative'}`}>
          {trendUp ? '↑' : '↓'} {deltaPP >= 0 ? '+' : ''}{deltaPP}pp vs last import
        </p>
      )}
    </div>
  );
}
