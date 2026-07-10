import { useMemo, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { usePersistedState } from '@/hooks/use-persisted-state';
import { openOpportunity } from '@/lib/openOpportunity';
import {
  currentDiscoveryDeals, discoveryTransitions, inspectOpportunity, inspectionNote,
  managerNoteStatus, transitionPriorityRank,
  type CheckLevel, type InspectionRow, type NoteStatus, type StageTransition,
} from '@/lib/inspection';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { SortHeader, type SortDir } from '@/components/sortableTable';
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

// Note-status badge styling: Applied=green, Missing=red, Re-inspect=amber.
const NOTE_STATUS_META: Record<NoteStatus, { level: CheckLevel; label: string; title: string }> = {
  applied: { level: 'pass', label: 'Applied', title: 'Manager note on file in the mandated format' },
  missing: { level: 'fail', label: 'Missing', title: 'No manager note, or note not in the mandated M/D/YYYY format' },
  stale: { level: 'warn', label: 'Re-inspect', title: 'Note is 14+ days old with no changes since — re-inspection due' },
};

// Urgency tiers, indexed by transitionPriorityRank (0 = most urgent). Rank 4 is "completed".
const URGENCY_TIER: { short: string; level: CheckLevel; label: string }[] = [
  { short: 'P1', level: 'fail', label: 'Missing note · leapfrog' },
  { short: 'P2', level: 'fail', label: 'Missing note' },
  { short: 'P3', level: 'warn', label: 'Re-inspect (stale note)' },
  { short: 'P4', level: 'warn', label: 'Applied note · a criterion still fails' },
  { short: 'P5', level: 'pass', label: 'Applied note · clean (completed)' },
];

// A transition enriched with its inspection, note status, and urgency rank.
interface QueueRow {
  t: StageTransition;
  row: InspectionRow | null;
  note: { status: NoteStatus; noteDate: Date | null };
  priorityRank: number;
}

type QueueSortKey = 'urgency' | 'account' | 'ae' | 'amount' | 'closeDate' | 'transitionDate' | 'noteStatus';

const NOTE_STATUS_RANK: Record<NoteStatus, number> = { missing: 0, stale: 1, applied: 2 };

// All comparators ascending; the hook/dir flips for descending.
const QUEUE_COMPARATORS: Record<QueueSortKey, (a: QueueRow, b: QueueRow) => number> = {
  urgency: (a, b) => a.priorityRank - b.priorityRank || a.t.entry.importDate.localeCompare(b.t.entry.importDate),
  account: (a, b) => (a.t.opp?.accountName ?? '').localeCompare(b.t.opp?.accountName ?? ''),
  ae: (a, b) => a.t.entry.repName.localeCompare(b.t.entry.repName),
  amount: (a, b) => (a.t.opp?.amount ?? 0) - (b.t.opp?.amount ?? 0),
  closeDate: (a, b) => (a.t.opp?.closeDate ?? '').localeCompare(b.t.opp?.closeDate ?? ''),
  transitionDate: (a, b) => a.t.entry.importDate.localeCompare(b.t.entry.importDate),
  noteStatus: (a, b) => NOTE_STATUS_RANK[a.note.status] - NOTE_STATUS_RANK[b.note.status],
};

/**
 * Opportunity name rendered as a direct Salesforce link when a URL is known;
 * otherwise falls back to the in-app Deal 360 opener, or plain text if neither.
 */
function OppNameLink({ name, url, oppId, className }: { name: string; url?: string; oppId?: string; className?: string }) {
  if (url) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className={className} title="Open in Salesforce">
        {name}
      </a>
    );
  }
  if (oppId) {
    return <button onClick={() => openOpportunity(oppId)} className={className} title="Open Deal 360">{name}</button>;
  }
  return <span className={className}>{name}</span>;
}

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
  const [noteFilter, setNoteFilter] = usePersistedState<'all' | 'missing' | 'reinspect'>('insp.noteFilter', 'all');
  const [showCompleted, setShowCompleted] = usePersistedState('insp.showCompleted', false);
  const [transcriptOpps, setTranscriptOpps] = useState<Set<string>>(new Set());

  // Work-queue sort. Default is the urgency ranking (ascending: most urgent first).
  const [sortKey, setSortKey] = useState<QueueSortKey>('urgency');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const isDefaultSort = sortKey === 'urgency' && sortDir === 'asc';
  const toggleSort = (key: QueueSortKey) => {
    if (key === sortKey) { setSortDir(d => (d === 'asc' ? 'desc' : 'asc')); return; }
    setSortKey(key);
    setSortDir(key === 'urgency' ? 'asc' : 'desc'); // urgency reads best ascending; metrics start descending
  };
  const resetSort = () => { setSortKey('urgency'); setSortDir('asc'); };

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
  // the sign-off list, plus its manager-note status and urgency rank.
  const transitionRows: QueueRow[] = useMemo(() => {
    const today = new Date();
    return transitions.map(t => {
      const row = t.opp
        ? inspectOpportunity(t.opp, transcriptOpps.has(t.opp.id), today, { leapfrog: t.leapfrog, transitionedAt: t.entry.importDate })
        : null;
      const note = t.opp
        ? managerNoteStatus(t.opp, changelog, today)
        : { status: 'missing' as NoteStatus, noteDate: null };
      return { t, row, note, priorityRank: transitionPriorityRank(note.status, !!t.leapfrog, row?.overall) };
    });
  }, [transitions, transcriptOpps, changelog]);

  // Sort by the active column (default urgency asc); ties within a column keep
  // the underlying urgency order because Array.sort is stable.
  const sortedTransitions = useMemo(() => {
    const cmp = QUEUE_COMPARATORS[sortKey];
    return [...transitionRows].sort((a, b) => (sortDir === 'desc' ? -cmp(a, b) : cmp(a, b)));
  }, [transitionRows, sortKey, sortDir]);

  // Default view hides completed rows (applied note, clean checks — rank 4).
  const visibleTransitions = showCompleted ? sortedTransitions : sortedTransitions.filter(q => q.priorityRank !== 4);
  const completedCount = transitionRows.filter(q => q.priorityRank === 4).length;

  // Pair each inspection row with its manager-note application status.
  const worklist = useMemo(() => {
    const today = new Date();
    return rows.map(r => ({ r, note: managerNoteStatus(r.opp, changelog, today) }));
  }, [rows, changelog]);

  const visible = worklist.filter(({ r, note }) => {
    if (onlyProblems && r.overall === 'pass') return false;
    if (noteFilter === 'missing' && note.status !== 'missing') return false;
    if (noteFilter === 'reinspect' && note.status !== 'stale') return false;
    return true;
  });
  const counts = {
    fail: rows.filter(r => r.overall === 'fail').length,
    warn: rows.filter(r => r.overall === 'warn').length,
    manual: rows.filter(r => r.overall === 'manual').length,
    pass: rows.filter(r => r.overall === 'pass').length,
  };
  const noteCounts = {
    missing: worklist.filter(w => w.note.status === 'missing').length,
    stale: worklist.filter(w => w.note.status === 'stale').length,
    applied: worklist.filter(w => w.note.status === 'applied').length,
  };

  // Generates a fresh note dated today from the current checks — so copying a
  // stale row produces a new attestation rather than recycling the old note.
  const copyNote = async (row: InspectionRow) => {
    const note = inspectionNote(row, initials);
    await navigator.clipboard.writeText(note);
    toast({ title: 'Note copied', description: note.slice(0, 80) + '…' });
  };

  const exportXlsx = () => {
    const wb = XLSX.utils.book_new();
    const sheet1 = worklist.map(({ r, note }) => ({
      Deal: r.opp.name,
      'Opportunity URL': r.opp.opportunityUrl || '',
      Rep: r.opp.repName,
      Amount: r.opp.amount,
      'Close Date': (r.opp.closeDate || '').slice(0, 10),
      'Next Step': r.opp.nextStep || '',
      Status: r.overall.toUpperCase(),
      'Note Status': NOTE_STATUS_META[note.status].label,
      C1: r.checks.find(c => c.criterion === 'C1')?.detail,
      C2: r.checks.find(c => c.criterion === 'C2')?.detail,
      'C3 Amount': r.checks.find(c => c.detail.toLowerCase().startsWith('amount'))?.detail,
      'C3 Close Date': r.checks.filter(c => c.criterion === 'C3').map(c => c.detail).find(d => d.toLowerCase().includes('close')) || '',
      'Manager Review Note': inspectionNote(r, initials),
    }));
    const ws1 = XLSX.utils.json_to_sheet(sheet1);
    ws1['!cols'] = [{ wch: 50 }, { wch: 60 }, { wch: 18 }, { wch: 10 }, { wch: 11 }, { wch: 30 }, { wch: 8 }, { wch: 12 }, { wch: 34 }, { wch: 34 }, { wch: 26 }, { wch: 30 }, { wch: 70 }];
    XLSX.utils.book_append_sheet(wb, ws1, 'Discovery 25 sign-off');
    // Export in the currently active sort order.
    const sheet2 = sortedTransitions.map(({ t, row, note, priorityRank }) => ({
      Urgency: URGENCY_TIER[priorityRank].short,
      Date: t.entry.importDate.slice(0, 10),
      Deal: t.entry.opportunityName,
      Account: t.opp?.accountName ?? '',
      'Opportunity URL': t.opp?.opportunityUrl || '',
      Rep: t.entry.repName,
      From: String(t.entry.oldValue),
      To: String(t.entry.newValue),
      Leapfrog: t.leapfrog ? 'YES' : '',
      Amount: t.opp?.amount ?? '',
      'Close Date': (t.opp?.closeDate ?? '').slice(0, 10),
      'Note Status': NOTE_STATUS_META[note.status].label,
      C1: row?.checks.find(c => c.criterion === 'C1')?.detail ?? '',
      C2: row?.checks.find(c => c.criterion === 'C2')?.detail ?? '',
      'C3 Amount': row?.checks.find(c => c.detail.toLowerCase().startsWith('amount'))?.detail ?? '',
      'C3 Close Date': row ? (row.checks.filter(c => c.criterion === 'C3').map(c => c.detail).find(d => d.toLowerCase().includes('close')) || '') : '',
      'Manager Review Note': row ? inspectionNote(row, initials) : '',
    }));
    const ws2 = XLSX.utils.json_to_sheet(sheet2.length ? sheet2 : [{ Urgency: '', Date: '', Deal: 'No transitions in window', Account: '', 'Opportunity URL': '', Rep: '', From: '', To: '', Leapfrog: '', Amount: '', 'Close Date': '', 'Note Status': '', C1: '', C2: '', 'C3 Amount': '', 'C3 Close Date': '', 'Manager Review Note': '' }]);
    ws2['!cols'] = [{ wch: 8 }, { wch: 11 }, { wch: 50 }, { wch: 24 }, { wch: 60 }, { wch: 18 }, { wch: 16 }, { wch: 16 }, { wch: 9 }, { wch: 10 }, { wch: 11 }, { wch: 12 }, { wch: 34 }, { wch: 34 }, { wch: 26 }, { wch: 30 }, { wch: 70 }];
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
          <div className="flex items-center gap-0.5 bg-secondary rounded-md p-0.5" title="Filter by manager-note status">
            {([['all', 'All'], ['missing', `Missing${noteCounts.missing ? ` ${noteCounts.missing}` : ''}`], ['reinspect', `Re-inspect${noteCounts.stale ? ` ${noteCounts.stale}` : ''}`]] as const).map(([key, label]) => (
              <button key={key} onClick={() => setNoteFilter(key)}
                className={`px-2 py-0.5 rounded text-[11px] font-medium ${noteFilter === key ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                {label}
              </button>
            ))}
          </div>
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
              <th className="px-3 py-2 font-medium">Note Status</th>
              <th className="px-3 py-2 font-medium">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.map(({ r, note }) => {
              const c1 = r.checks.find(c => c.criterion === 'C1')!;
              const c2 = r.checks.find(c => c.criterion === 'C2')!;
              const c3s = r.checks.filter(c => c.criterion === 'C3');
              const c3worst = c3s.reduce((w, c) => (LEVEL_RANK[c.level] > LEVEL_RANK[w.level] ? c : w));
              const noteMeta = NOTE_STATUS_META[note.status];
              return (
                <tr key={r.opp.id} className="hover:bg-muted/40">
                  <td className="px-3 py-1.5 max-w-[260px]">
                    <OppNameLink name={r.opp.name} url={r.opp.opportunityUrl} oppId={r.opp.id} className="text-left hover:underline truncate block w-full" />
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{r.opp.repName}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">{fmt(r.opp.amount)}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{(r.opp.closeDate || '').slice(5, 10)}</td>
                  <td className="px-3 py-1.5"><LevelChip level={c1.level} label={c1.level === 'pass' ? 'transcript' : 'review call'} title={c1.detail} /></td>
                  <td className="px-3 py-1.5"><LevelChip level={c2.level} label={c2.level} title={c2.detail} /></td>
                  <td className="px-3 py-1.5"><LevelChip level={c3worst.level} label={c3worst.level} title={c3s.map(c => c.detail).join(' · ')} /></td>
                  <td className="px-3 py-1.5"><LevelChip level={noteMeta.level} label={noteMeta.label} title={noteMeta.title} /></td>
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
        <div className="flex items-center justify-between flex-wrap gap-2 px-3 py-2 border-b border-border">
          <span className="flex items-center gap-2 text-sm font-medium">
            <ClipboardCheck size={14} className="text-muted-foreground" />
            Stage transitions requiring notes
            <span className="text-xs text-muted-foreground font-normal">Qualified 5% to Discovery 25%, from import history</span>
          </span>
          <div className="flex items-center gap-2">
            {!isDefaultSort && (
              <button onClick={resetSort} title="Sort by urgency (default order)"
                className="px-2 py-0.5 rounded text-[11px] font-medium border border-border text-muted-foreground hover:text-foreground">
                Reset to urgency
              </button>
            )}
            <button onClick={() => setShowCompleted(v => !v)}
              className={`px-2 py-0.5 rounded text-[11px] font-medium border ${showCompleted ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground'}`}>
              Show completed{completedCount ? ` (${completedCount})` : ''}
            </button>
            <div className="flex items-center gap-0.5 bg-secondary rounded-md p-0.5">
              {[7, 14, 30].map(dys => (
                <button key={dys} onClick={() => setWindowDays(dys)}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium ${windowDays === dys ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                  {dys}d
                </button>
              ))}
            </div>
          </div>
        </div>
        {transitions.length === 0 ? (
          <p className="text-xs text-muted-foreground px-3 py-3">No Qualified-to-Discovery transitions captured in the last {windowDays} days of imports.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border bg-muted/30">
                  <SortHeader field="urgency" label="Urgency" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="px-3 py-2 font-medium" title="Priority rank — the default order" />
                  <th className="px-3 py-2 font-medium">Deal</th>
                  <SortHeader field="account" label="Account" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="px-3 py-2 font-medium" />
                  <SortHeader field="ae" label="AE" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="px-3 py-2 font-medium" />
                  <SortHeader field="amount" label="Amount" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
                  <SortHeader field="closeDate" label="Close" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="px-3 py-2 font-medium" />
                  <SortHeader field="transitionDate" label="Transition" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="px-3 py-2 font-medium" />
                  <th className="px-3 py-2 font-medium">Checks</th>
                  <SortHeader field="noteStatus" label="Note Status" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="px-3 py-2 font-medium" />
                  <th className="px-3 py-2 font-medium">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visibleTransitions.length === 0 ? (
                  <tr><td colSpan={10} className="px-3 py-3 text-muted-foreground">
                    Every transition in this window has a completed note. {completedCount > 0 && 'Toggle “Show completed” to view them.'}
                  </td></tr>
                ) : visibleTransitions.map(({ t, row, note, priorityRank }) => {
                  const c1 = row?.checks.find(c => c.criterion === 'C1');
                  const c2 = row?.checks.find(c => c.criterion === 'C2');
                  const c3s = row?.checks.filter(c => c.criterion === 'C3') ?? [];
                  const c3worst = c3s.length ? c3s.reduce((w, c) => (LEVEL_RANK[c.level] > LEVEL_RANK[w.level] ? c : w)) : null;
                  const tier = URGENCY_TIER[priorityRank];
                  const noteMeta = NOTE_STATUS_META[note.status];
                  return (
                    <tr key={t.entry.id} className="hover:bg-muted/40 align-top">
                      <td className="px-3 py-1.5"><LevelChip level={tier.level} label={tier.short} title={tier.label} /></td>
                      <td className="px-3 py-1.5 max-w-[260px]">
                        <OppNameLink name={t.entry.opportunityName} url={t.opp?.opportunityUrl} oppId={t.opp?.id} className="truncate block w-full text-left hover:underline" />
                      </td>
                      <td className="px-3 py-1.5 max-w-[160px] truncate" title={t.opp?.accountName}>{t.opp?.accountName || '—'}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{t.entry.repName}</td>
                      <td className="px-3 py-1.5 text-right whitespace-nowrap">{t.opp ? fmt(t.opp.amount) : '—'}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{(t.opp?.closeDate || '').slice(0, 10) || '—'}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        <div>{t.entry.importDate.slice(0, 10)}</div>
                        <div className="text-muted-foreground flex items-center gap-1">
                          <span>{String(t.entry.oldValue)} → {String(t.entry.newValue)}</span>
                          {t.leapfrog && <LevelChip level="fail" label="LEAPFROG" title="Bypassed the Qualified 5% stage — retroactive inspection" />}
                        </div>
                      </td>
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-1 flex-wrap">
                          {c1 && <LevelChip level={c1.level} label={c1.level === 'pass' ? 'C1 transcript' : 'C1 review call'} title={c1.detail} />}
                          {c2 && <LevelChip level={c2.level} label={`C2 ${c2.level}`} title={c2.detail} />}
                          {c3worst && <LevelChip level={c3worst.level} label={`C3 ${c3worst.level}`} title={c3s.map(c => c.detail).join(' · ')} />}
                          {c1?.level === 'manual' && <PendingBadge />}
                        </div>
                      </td>
                      <td className="px-3 py-1.5"><LevelChip level={noteMeta.level} label={noteMeta.label} title={noteMeta.title} /></td>
                      <td className="px-3 py-1.5">
                        {row && (
                          <button onClick={() => copyNote(row)} className="flex items-center gap-1 text-muted-foreground hover:text-foreground" title={inspectionNote(row, initials)}>
                            <Copy size={11} /> note
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[10px] text-muted-foreground px-3 py-2 border-t border-border">
          Transitions are detected between imports, so same-week moves appear after your next import. For backfill before Jul 5, use the Salesforce field-history report; history for some deals prior to that date was not retained.
        </p>
      </div>
    </div>
  );
}
