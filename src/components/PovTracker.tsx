import { useMemo, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { detectMotions, motionStats, type MotionKind, type MotionRecord } from '@/lib/povTracking';
import { openOpportunity } from '@/lib/openOpportunity';
import { usePersistedState } from '@/hooks/use-persisted-state';
import { ChevronDown, ChevronUp, Download, FlaskConical, Pencil, X } from 'lucide-react';
import * as XLSX from '@e965/xlsx';
import type { Opportunity } from '@/types/forecast';

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function ageTone(days: number): string {
  if (days > 60) return 'text-red-500';
  if (days > 45) return 'text-amber-500';
  return 'text-muted-foreground';
}

function outcomeBadge(r: MotionRecord) {
  const map: Record<MotionRecord['outcome'], string> = {
    active: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
    won: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    lost: 'bg-red-500/15 text-red-600 dark:text-red-400',
    rejected: 'bg-muted text-muted-foreground',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${map[r.outcome]}`}>
      {r.outcome}
    </span>
  );
}

function MotionTable({ records, onSetStart, onClearStart }: {
  records: MotionRecord[];
  onSetStart: (oppId: string, kind: MotionRecord['kind'], iso: string) => void;
  onClearStart: (oppId: string, kind: MotionRecord['kind']) => void;
}) {
  const [showConcluded, setShowConcluded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const visible = showConcluded ? records : records.filter(r => r.outcome === 'active');
  const concludedCount = records.length - records.filter(r => r.outcome === 'active').length;

  if (records.length === 0) {
    return <p className="text-xs text-muted-foreground px-3 py-3">No deals carry this token yet.</p>;
  }

  return (
    <div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground border-b border-border">
            <th className="px-3 py-1.5 font-medium">Deal</th>
            <th className="px-3 py-1.5 font-medium">Rep</th>
            <th className="px-3 py-1.5 font-medium text-right">Amount</th>
            <th className="px-3 py-1.5 font-medium">Started</th>
            <th className="px-3 py-1.5 font-medium text-right">Days</th>
            <th className="px-3 py-1.5 font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {visible.map(r => (
            <tr key={r.opportunityId} className="hover:bg-muted/40">
              <td className="px-3 py-1.5 max-w-[280px]">
                <button
                  onClick={() => openOpportunity(r.opportunityId)}
                  className="text-left hover:underline truncate block w-full"
                  title="Open Deal 360"
                >{r.name}</button>
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap">{r.repName}</td>
              <td className="px-3 py-1.5 text-right whitespace-nowrap">{fmt(r.amount)}</td>
              <td className="px-3 py-1.5 whitespace-nowrap">
                {editingId === r.opportunityId ? (
                  <span className="flex items-center gap-1">
                    <input
                      type="date"
                      defaultValue={r.startedAt.slice(0, 10)}
                      autoFocus
                      onKeyDown={e => { if (e.key === 'Escape') setEditingId(null); }}
                      onChange={e => {
                        if (!e.target.value) return;
                        onSetStart(r.opportunityId, r.kind, new Date(e.target.value + 'T00:00:00').toISOString());
                        setEditingId(null);
                      }}
                      className="bg-background border border-border rounded px-1 py-0.5 text-xs w-[120px]"
                    />
                    <button onClick={() => setEditingId(null)} className="text-muted-foreground hover:text-foreground"><X size={11} /></button>
                  </span>
                ) : (
                  <span className="group/date flex items-center gap-1">
                    <span title={r.startSource === 'manual' ? 'Manually set start date.' : r.startApproximate ? 'Token was already in the name at first import; actual start may be earlier. Click the pencil to correct it.' : 'Date the token was added to the opportunity name.'}>
                      {new Date(r.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      {r.startApproximate && <span className="text-muted-foreground">~</span>}
                      {r.startSource === 'manual' && <span className="text-muted-foreground" title="Manually set">*</span>}
                    </span>
                    <button
                      onClick={() => setEditingId(r.opportunityId)}
                      className="opacity-0 group-hover/date:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
                      title="Edit start date"
                    ><Pencil size={10} /></button>
                    {r.startSource === 'manual' && (
                      <button
                        onClick={() => onClearStart(r.opportunityId, r.kind)}
                        className="opacity-0 group-hover/date:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
                        title="Clear override, return to detected date"
                      ><X size={10} /></button>
                    )}
                  </span>
                )}
              </td>
              <td className={`px-3 py-1.5 text-right font-medium ${r.outcome === 'active' ? ageTone(r.durationDays) : 'text-muted-foreground'}`}>
                {r.durationDays}
              </td>
              <td className="px-3 py-1.5">{outcomeBadge(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {concludedCount > 0 && (
        <button
          onClick={() => setShowConcluded(v => !v)}
          className="w-full text-center text-[11px] text-muted-foreground hover:text-foreground py-1.5 border-t border-border"
        >
          {showConcluded ? 'Hide' : 'Show'} {concludedCount} concluded
        </button>
      )}
    </div>
  );
}

/**
 * POV / RFP tracker. Detection is name-token based (the only signal that
 * exists: neither motion is a Salesforce field). Start dates come from the
 * name-change changelog; a ~ marks deals whose token predates tracking.
 */
export default function PovTracker() {
  const { opportunities, changelog, updateOpportunity } = useForecast();
  const [expanded, setExpanded] = usePersistedState('pov.expanded', true);
  const [kind, setKind] = usePersistedState<MotionKind>('pov.kind', 'POV');

  const { records, stats } = useMemo(() => {
    const records = detectMotions(opportunities, changelog, kind);
    return { records, stats: motionStats(records, kind) };
  }, [opportunities, changelog, kind]);

  const setStart = (oppId: string, k: MotionKind, iso: string) => {
    const opp = opportunities.find(o => o.id === oppId);
    updateOpportunity(oppId, { motionStartOverrides: { ...(opp as Opportunity | undefined)?.motionStartOverrides, [k]: iso } });
  };
  const clearStart = (oppId: string, k: MotionKind) => {
    const opp = opportunities.find(o => o.id === oppId);
    const next = { ...(opp as Opportunity | undefined)?.motionStartOverrides };
    delete next[k];
    updateOpportunity(oppId, { motionStartOverrides: next });
  };

  const exportXlsx = () => {
    const wb = XLSX.utils.book_new();
    for (const k of ['POV', 'RFP'] as MotionKind[]) {
      const recs = detectMotions(opportunities, changelog, k);
      const st = motionStats(recs, k);
      const rows = recs.map(r => ({
        Deal: r.name,
        Rep: r.repName,
        Amount: r.amount,
        Started: r.startedAt.slice(0, 10),
        'Start source': r.startSource === 'manual' ? 'Manual' : r.startSource === 'observed' ? 'Name change' : 'First import (approx.)',
        Days: r.durationDays,
        Status: r.outcome,
        'Close date': (r.closeDate || '').slice(0, 10),
        Classification: r.classification,
      }));
      rows.push({} as any, {
        Deal: `Active: ${st.activeCount} ($${Math.round(st.activeAmount).toLocaleString()})`,
        Rep: `Concluded: ${st.concludedCount}`,
        Amount: '' as any,
        Started: `Win rate: ${st.conversionRate === null ? 'n/a' : Math.round(st.conversionRate * 100) + '%'}`,
        'Start source': `Median days (observed/manual): ${st.medianDurationDays ?? 'n/a'}`,
        Days: '' as any, Status: '' as any, 'Close date': '' as any, Classification: '' as any,
      });
      const ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [{ wch: 52 }, { wch: 18 }, { wch: 11 }, { wch: 11 }, { wch: 22 }, { wch: 6 }, { wch: 9 }, { wch: 11 }, { wch: 13 }];
      XLSX.utils.book_append_sheet(wb, ws, k);
    }
    XLSX.writeFile(wb, `pov-rfp-report-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <div className="border border-border rounded-lg bg-card">
      <div className="flex items-center justify-between px-3 py-2">
        <button onClick={() => setExpanded(v => !v)} className="flex items-center gap-2 text-sm font-medium">
          <FlaskConical size={14} className="text-muted-foreground" />
          POV / RFP Tracker
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={exportXlsx}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            title="Export both POV and RFP sheets to Excel"
          >
            <Download size={12} /> Excel
          </button>
          <div className="flex items-center gap-0.5 bg-secondary rounded-md p-0.5">
          {(['POV', 'RFP'] as MotionKind[]).map(k => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${kind === k ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >{k}</button>
          ))}
          </div>
        </div>
      </div>
      {expanded && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border border-t border-border text-center">
            <div className="bg-card px-2 py-2">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Active</p>
              <p className="text-sm font-semibold">{stats.activeCount} · {fmt(stats.activeAmount)}</p>
            </div>
            <div className="bg-card px-2 py-2">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Concluded</p>
              <p className="text-sm font-semibold">{stats.concludedCount}</p>
            </div>
            <div className="bg-card px-2 py-2">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Win rate</p>
              <p className="text-sm font-semibold">{stats.conversionRate === null ? 'n/a' : `${Math.round(stats.conversionRate * 100)}%`}</p>
            </div>
            <div className="bg-card px-2 py-2">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Median days</p>
              <p className="text-sm font-semibold">{stats.medianDurationDays ?? 'n/a'}</p>
            </div>
          </div>
          <div className="border-t border-border overflow-x-auto">
            <MotionTable records={records} onSetStart={setStart} onClearStart={clearStart} />
          </div>
        </>
      )}
    </div>
  );
}
