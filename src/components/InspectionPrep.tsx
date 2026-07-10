import { useMemo, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { usePersistedState } from '@/hooks/use-persisted-state';
import { openOpportunity } from '@/lib/openOpportunity';
import {
  currentDiscoveryDeals, discoveryTransitions, inspectOpportunity, inspectionNote,
  type CheckLevel, type InspectionRow,
} from '@/lib/inspection';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Copy, Download, ClipboardCheck } from 'lucide-react';
import * as XLSX from '@e965/xlsx';
import { useEffect } from 'react';

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const LEVEL_STYLE: Record<CheckLevel, string> = {
  pass: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  warn: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  fail: 'bg-red-500/15 text-red-600 dark:text-red-400',
  manual: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
};

const LEVEL_RANK: Record<CheckLevel, number> = { fail: 3, warn: 2, manual: 1, pass: 0 };

function LevelChip({ level, label, title }: { level: CheckLevel; label: string; title?: string }) {
  return (
    <span title={title} className={`px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap ${LEVEL_STYLE[level]}`}>
      {label}
    </span>
  );
}

/** Shown wherever a C1-manual row can be copied, so a pending call review is visible before pasting. */
function PendingBadge() {
  return (
    <span
      title="No transcript on file — discovery call review not yet performed"
      className={`px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap ${LEVEL_STYLE.manual}`}
    >call review pending</span>
  );
}

export default function InspectionPrep() {
  const { opportunities, changelog } = useForecast();
  const { toast } = useToast();
  const [initials, setInitials] = usePersistedState('insp.initials', '');
  const [windowDays, setWindowDays] = usePersistedState('insp.window', 14);
  const [onlyProblems, setOnlyProblems] = usePersistedState('insp.onlyProblems', false);
  const [transcriptOpps, setTranscriptOpps] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    supabase.from('transcripts').select('opp_id').then(
      ({ data }) => { if (!cancelled && data) setTranscriptOpps(new Set(data.map((r: any) => r.opp_id))); },
      () => { /* offline: C1 falls back to manual review */ },
    );
    return () => { cancelled = true; };
  }, []);

  const rows: InspectionRow[] = useMemo(() => {
    const today = new Date();
    return currentDiscoveryDeals(opportunities)
      .map(o => inspectOpportunity(o, transcriptOpps.has(o.id), today))
      .sort((a, b) => ({ fail: 0, warn: 1, manual: 2, pass: 3 }[a.overall] - { fail: 0, warn: 1, manual: 2, pass: 3 }[b.overall]));
  }, [opportunities, transcriptOpps]);

  const transitions = useMemo(() => {
    const since = new Date(Date.now() - windowDays * 86400000).toISOString();
    return discoveryTransitions(changelog, opportunities, since);
  }, [changelog, opportunities, windowDays]);

  // Run the full C1/C2/C3 inspection on each transition (leapfrogs included) so
  // the audit rows carry the same per-criterion badges and note generation as
  // the sign-off list. The leapfrog flag flows into the note wording.
  const transitionRows = useMemo(() =>
    transitions.map(t => ({
      t,
      row: t.opp
        ? inspectOpportunity(t.opp, transcriptOpps.has(t.opp.id), new Date(), { leapfrog: t.leapfrog, transitionedAt: t.entry.importDate })
        : null,
    })),
    [transitions, transcriptOpps]);

  const visible = onlyProblems ? rows.filter(r => r.overall !== 'pass') : rows;
  const counts = {
    fail: rows.filter(r => r.overall === 'fail').length,
    warn: rows.filter(r => r.overall === 'warn').length,
    manual: rows.filter(r => r.overall === 'manual').length,
    pass: rows.filter(r => r.overall === 'pass').length,
  };

  const copyNote = async (row: InspectionRow) => {
    const note = inspectionNote(row, initials);
    await navigator.clipboard.writeText(note);
    toast({ title: 'Note copied', description: note.slice(0, 80) + '…' });
  };

  const exportXlsx = () => {
    const wb = XLSX.utils.book_new();
    const sheet1 = rows.map(r => ({
      Deal: r.opp.name,
      Rep: r.opp.repName,
      Amount: r.opp.amount,
      'Close Date': (r.opp.closeDate || '').slice(0, 10),
      'Next Step': r.opp.nextStep || '',
      Status: r.overall.toUpperCase(),
      C1: r.checks.find(c => c.criterion === 'C1')?.detail,
      C2: r.checks.find(c => c.criterion === 'C2')?.detail,
      'C3 Amount': r.checks.find(c => c.detail.toLowerCase().startsWith('amount'))?.detail,
      'C3 Close Date': r.checks.filter(c => c.criterion === 'C3').map(c => c.detail).find(d => d.toLowerCase().includes('close')) || '',
      'Manager Review Note': inspectionNote(r, initials),
    }));
    const ws1 = XLSX.utils.json_to_sheet(sheet1);
    ws1['!cols'] = [{ wch: 50 }, { wch: 18 }, { wch: 10 }, { wch: 11 }, { wch: 30 }, { wch: 8 }, { wch: 34 }, { wch: 34 }, { wch: 26 }, { wch: 30 }, { wch: 70 }];
    XLSX.utils.book_append_sheet(wb, ws1, 'Discovery 25 sign-off');
    const sheet2 = transitionRows.map(({ t, row }) => ({
      Date: t.entry.importDate.slice(0, 10),
      Deal: t.entry.opportunityName,
      Rep: t.entry.repName,
      From: String(t.entry.oldValue),
      To: String(t.entry.newValue),
      Leapfrog: t.leapfrog ? 'YES' : '',
      Amount: t.opp?.amount ?? '',
      C1: row?.checks.find(c => c.criterion === 'C1')?.detail ?? '',
      C2: row?.checks.find(c => c.criterion === 'C2')?.detail ?? '',
      'C3 Amount': row?.checks.find(c => c.detail.toLowerCase().startsWith('amount'))?.detail ?? '',
      'C3 Close Date': row ? (row.checks.filter(c => c.criterion === 'C3').map(c => c.detail).find(d => d.toLowerCase().includes('close')) || '') : '',
      'Manager Review Note': row ? inspectionNote(row, initials) : '',
    }));
    const ws2 = XLSX.utils.json_to_sheet(sheet2.length ? sheet2 : [{ Date: '', Deal: 'No transitions in window', Rep: '', From: '', To: '', Leapfrog: '', Amount: '', C1: '', C2: '', 'C3 Amount': '', 'C3 Close Date': '', 'Manager Review Note': '' }]);
    ws2['!cols'] = [{ wch: 11 }, { wch: 50 }, { wch: 18 }, { wch: 16 }, { wch: 16 }, { wch: 9 }, { wch: 10 }, { wch: 34 }, { wch: 34 }, { wch: 26 }, { wch: 30 }, { wch: 70 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'Stage transitions');
    XLSX.writeFile(wb, `sql-inspection-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-baseline gap-3">
          <span className="text-2xl font-semibold">{rows.length}</span>
          <span className="text-xs text-muted-foreground uppercase tracking-wide">open Discovery 25% deals</span>
          <span className="text-xs">
            <LevelChip level="fail" label={`${counts.fail} fail`} /> <LevelChip level="warn" label={`${counts.warn} warn`} />{' '}
            <LevelChip level="manual" label={`${counts.manual} manual C1`} /> <LevelChip level="pass" label={`${counts.pass} pass`} />
          </span>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-muted-foreground">Initials</label>
          <input
            value={initials}
            onChange={e => setInitials(e.target.value.slice(0, 4))}
            placeholder="MB"
            className="w-14 bg-background border border-border rounded px-1.5 py-1 text-xs"
          />
          <button
            onClick={() => setOnlyProblems(v => !v)}
            className={`px-2 py-1 rounded text-[11px] border ${onlyProblems ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground'}`}
          >Problems only</button>
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={exportXlsx}>
            <Download size={12} /> Excel worklist
          </Button>
        </div>
      </div>

      <div className="border border-border rounded-lg overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground border-b border-border bg-muted/30">
              <th className="px-3 py-2 font-medium">Deal</th>
              <th className="px-3 py-2 font-medium">Rep</th>
              <th className="px-3 py-2 font-medium text-right">Amount</th>
              <th className="px-3 py-2 font-medium">Close</th>
              <th className="px-3 py-2 font-medium">C1</th>
              <th className="px-3 py-2 font-medium">C2 Next Step</th>
              <th className="px-3 py-2 font-medium">C3</th>
              <th className="px-3 py-2 font-medium">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.map(r => {
              const c1 = r.checks.find(c => c.criterion === 'C1')!;
              const c2 = r.checks.find(c => c.criterion === 'C2')!;
              const c3s = r.checks.filter(c => c.criterion === 'C3');
              const c3worst = c3s.reduce((w, c) => (({ fail: 3, warn: 2, manual: 1, pass: 0 })[c.level] > ({ fail: 3, warn: 2, manual: 1, pass: 0 })[w.level] ? c : w));
              return (
                <tr key={r.opp.id} className="hover:bg-muted/40">
                  <td className="px-3 py-1.5 max-w-[260px]">
                    <button onClick={() => openOpportunity(r.opp.id)} className="text-left hover:underline truncate block w-full" title="Open Deal 360">
                      {r.opp.name}
                    </button>
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{r.opp.repName}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">{fmt(r.opp.amount)}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{(r.opp.closeDate || '').slice(5, 10)}</td>
                  <td className="px-3 py-1.5"><LevelChip level={c1.level} label={c1.level === 'pass' ? 'transcript' : 'review call'} title={c1.detail} /></td>
                  <td className="px-3 py-1.5"><LevelChip level={c2.level} label={c2.level} title={c2.detail} /></td>
                  <td className="px-3 py-1.5"><LevelChip level={c3worst.level} label={c3worst.level} title={c3s.map(c => c.detail).join(' · ')} /></td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => copyNote(r)} className="flex items-center gap-1 text-muted-foreground hover:text-foreground" title={inspectionNote(r, initials)}>
                        <Copy size={11} /> copy
                      </button>
                      {c1.level === 'manual' && <PendingBadge />}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="border border-border rounded-lg">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="flex items-center gap-2 text-sm font-medium">
            <ClipboardCheck size={14} className="text-muted-foreground" />
            Stage transitions requiring notes
            <span className="text-xs text-muted-foreground font-normal">Qualified 5% to Discovery 25%, from import history</span>
          </span>
          <div className="flex items-center gap-0.5 bg-secondary rounded-md p-0.5">
            {[7, 14, 30].map(dys => (
              <button key={dys} onClick={() => setWindowDays(dys)}
                className={`px-2 py-0.5 rounded text-[11px] font-medium ${windowDays === dys ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                {dys}d
              </button>
            ))}
          </div>
        </div>
        {transitions.length === 0 ? (
          <p className="text-xs text-muted-foreground px-3 py-3">No Qualified-to-Discovery transitions captured in the last {windowDays} days of imports.</p>
        ) : (
          <div className="divide-y divide-border">
            {transitionRows.map(({ t, row }) => {
              const c1 = row?.checks.find(c => c.criterion === 'C1');
              const c2 = row?.checks.find(c => c.criterion === 'C2');
              const c3s = row?.checks.filter(c => c.criterion === 'C3') ?? [];
              const c3worst = c3s.length ? c3s.reduce((w, c) => (LEVEL_RANK[c.level] > LEVEL_RANK[w.level] ? c : w)) : null;
              return (
                <div key={t.entry.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                  <div className="min-w-0">
                    <button
                      onClick={() => t.opp && openOpportunity(t.opp.id)}
                      className={`truncate block max-w-[420px] text-left ${t.opp ? 'hover:underline' : ''}`}
                    >
                      {t.entry.opportunityName}
                    </button>
                    <p className="text-muted-foreground">{t.entry.repName} · {t.entry.importDate.slice(0, 10)} · {String(t.entry.oldValue)} to {String(t.entry.newValue)}</p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                    {t.leapfrog && <LevelChip level="fail" label="LEAPFROG" title="Bypassed the Qualified 5% stage — retroactive inspection" />}
                    {c1 && <LevelChip level={c1.level} label={c1.level === 'pass' ? 'C1 transcript' : 'C1 review call'} title={c1.detail} />}
                    {c2 && <LevelChip level={c2.level} label={`C2 ${c2.level}`} title={c2.detail} />}
                    {c3worst && <LevelChip level={c3worst.level} label={`C3 ${c3worst.level}`} title={c3s.map(c => c.detail).join(' · ')} />}
                    {c1?.level === 'manual' && <PendingBadge />}
                    {row && (
                      <button
                        onClick={() => copyNote(row)}
                        className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                        title={inspectionNote(row, initials)}
                      ><Copy size={11} /> note</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p className="text-[10px] text-muted-foreground px-3 py-2 border-t border-border">
          Transitions are detected between imports, so same-week moves appear after your next import. For backfill before Jul 5, use the Salesforce field-history report; history for some deals prior to that date was not retained.
        </p>
      </div>
    </div>
  );
}
