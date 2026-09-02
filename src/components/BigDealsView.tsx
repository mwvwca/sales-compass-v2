import { Fragment, useCallback, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Check, FileText } from 'lucide-react';
import { useForecast } from '@/context/ForecastContext';
import { usePersistedState } from '@/hooks/use-persisted-state';
import { getMonthKey, getQuarter, type Quarter } from '@/types/forecast';
import { buildTeamRepNameSet, isTeamOwned } from '@/lib/repUtils';
import { QUOTE_STATE_BADGE, reconcileQuote } from '@/lib/quoteReconciliation';
import { openOpportunity } from '@/lib/openOpportunity';
import { INVOLVEMENT_META, nextInvolvementStatus, type InvolvementStatus } from '@/lib/involvement';
import {
  DEFAULT_BIG_DEAL_THRESHOLD, briefingPeriodKey, buildFridayBriefing, buildRepPipeline,
  cohortTotal, computeMovement, fmtDate, fmtMoney, isOpenDeal, monthName, movementBaseline,
  recordRun, repNotesForPeriod, selectBigDeals, toCohortMember,
  type BigDealRow, type Movement,
} from '@/lib/bigDeals';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';

/**
 * Big Deals — the manager's standing weekly cohort, plus the Friday briefing built from it.
 *
 * The cohort is derived at render time (team membership, open stage, close month, amount
 * threshold) and joined to the involvement slice by Salesforce id, so an import can change
 * the deals on the list but can never touch what the manager recorded about them.
 */

const numberOrDefault = (raw: string, fallback: number) => {
  const n = Number(raw.replace(/[^0-9.]/g, ''));
  return isFinite(n) && n >= 0 ? n : fallback;
};

/** The frozen part of a generated briefing: movement is measured once, at generation. */
interface BriefingSession {
  movement: Movement;
  generatedAt: string;
}

export default function BigDealsView() {
  const {
    opportunities, reps, snapshots, changelog, involvement, briefingMeta,
    setInvolvement, updateBriefingMeta,
  } = useForecast();

  const currentMonth = useMemo(() => getMonthKey(new Date().toISOString()), []);
  const [monthKey, setMonthKey] = usePersistedState<string>('bigDeals.month', currentMonth);
  const [threshold, setThreshold] = usePersistedState<number>('bigDeals.threshold', DEFAULT_BIG_DEAL_THRESHOLD);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [briefingOpen, setBriefingOpen] = useState(false);
  const [session, setSession] = useState<BriefingSession | null>(null);
  const [copied, setCopied] = useState(false);

  const teamRepNameSet = useMemo(() => buildTeamRepNameSet(reps), [reps]);

  // Months to choose from: every month a team-owned open deal closes in, plus this one.
  const monthOptions = useMemo(() => {
    const months = new Set<string>([currentMonth, monthKey]);
    for (const o of opportunities) {
      if (!o.closeDate || !isOpenDeal(o) || !isTeamOwned(o, teamRepNameSet)) continue;
      months.add(getMonthKey(o.closeDate));
    }
    return Array.from(months).filter(Boolean).sort();
  }, [opportunities, teamRepNameSet, currentMonth, monthKey]);

  const rows = useMemo(
    () => selectBigDeals({ opportunities, reps, snapshots, involvement, monthKey, threshold, now: new Date() }),
    [opportunities, reps, snapshots, involvement, monthKey, threshold],
  );
  const total = cohortTotal(rows);

  const quarter: Quarter = useMemo(() => getQuarter(`${monthKey}-01`), [monthKey]);
  const period = useMemo(() => briefingPeriodKey(new Date()), []);
  const repNotes = repNotesForPeriod(briefingMeta, period);

  const repRows = useMemo(
    () => buildRepPipeline({ opportunities, reps, quarter, coverageLine: briefingMeta.coverageLine, repNotes }),
    [opportunities, reps, quarter, briefingMeta.coverageLine, repNotes],
  );

  const toggleExpanded = (key: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const cycleInvolvement = (row: BigDealRow) => {
    const next: InvolvementStatus = nextInvolvementStatus(row.involvement.status);
    setInvolvement(row.key, { status: next });
  };

  // Generating records the run: the timestamp becomes next week's movement window, and
  // the cohort captured here is what next week's "left the cohort" is measured against.
  const generate = useCallback(() => {
    const now = new Date();
    const baseline = movementBaseline(briefingMeta, period);
    const movement = computeMovement({ rows, opportunities, reps, changelog, baseline, monthKey, threshold });
    const generatedAt = now.toISOString();
    updateBriefingMeta(recordRun(briefingMeta, period, {
      generatedAt, monthKey, threshold, cohort: rows.map(toCohortMember),
    }));
    setSession({ movement, generatedAt });
    setBriefingOpen(true);
  }, [briefingMeta, period, rows, opportunities, reps, changelog, monthKey, threshold, updateBriefingMeta]);

  const briefingText = useMemo(() => {
    if (!session) return '';
    return buildFridayBriefing({
      rows,
      movement: session.movement,
      repRows,
      monthKey,
      quarter,
      threshold,
      monthlyTarget: briefingMeta.monthlyTarget,
      coverageLine: briefingMeta.coverageLine,
      now: new Date(session.generatedAt),
    });
  }, [session, rows, repRows, monthKey, quarter, threshold, briefingMeta.monthlyTarget, briefingMeta.coverageLine]);

  const copyBriefing = async () => {
    await navigator.clipboard.writeText(briefingText);
    setCopied(true);
    toast.success('Briefing copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  };

  const setRepNote = (repName: string, text: string) => {
    updateBriefingMeta({ notesPeriod: period, repNotes: { ...repNotes, [repName]: text } });
  };

  return (
    <div className="space-y-4">
      {/* Cohort header + controls */}
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="text-2xl font-semibold">{rows.length}</span>
        <span className="text-xs text-muted-foreground uppercase tracking-wide">
          open {monthName(monthKey)} deals at {fmtMoney(threshold)}+
        </span>
        <span className="text-sm font-medium">{fmtMoney(total)}</span>
        <span className="text-xs text-muted-foreground">
          of the {fmtMoney(briefingMeta.monthlyTarget)} {monthName(monthKey)} path
        </span>
        <div className="ml-auto">
          <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={generate}>
            <FileText size={14} />
            Generate Briefing
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Month
          <select
            value={monthKey}
            onChange={e => setMonthKey(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {monthOptions.map(m => <option key={m} value={m}>{monthName(m)} {m.slice(0, 4)}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Threshold
          <input
            type="text"
            defaultValue={String(threshold)}
            onBlur={e => {
              const v = numberOrDefault(e.target.value, threshold);
              e.target.value = String(v);
              setThreshold(v);
            }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            className="w-24 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Monthly target
          <input
            type="text"
            defaultValue={String(briefingMeta.monthlyTarget)}
            onBlur={e => {
              const v = numberOrDefault(e.target.value, briefingMeta.monthlyTarget);
              e.target.value = String(v);
              updateBriefingMeta({ monthlyTarget: v });
            }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            className="w-28 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Coverage line
          <input
            type="text"
            defaultValue={String(briefingMeta.coverageLine)}
            onBlur={e => {
              const v = numberOrDefault(e.target.value, briefingMeta.coverageLine);
              e.target.value = String(v);
              updateBriefingMeta({ coverageLine: v });
            }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            className="w-16 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </label>
      </div>

      {/* Cohort table */}
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground py-6 text-center">
          No open team-owned deals closing in {monthName(monthKey)} at {fmtMoney(threshold)} or above.
        </p>
      ) : (
        <div className="overflow-x-auto border border-border rounded-md">
          <table className="w-full text-xs">
            <thead className="bg-secondary/40 text-muted-foreground">
              <tr>
                <th className="w-6" />
                <th className="text-left px-2 py-1.5 font-medium">Deal</th>
                <th className="text-left px-2 py-1.5 font-medium">Rep</th>
                <th className="text-right px-2 py-1.5 font-medium">Amount</th>
                <th className="text-left px-2 py-1.5 font-medium">Stage</th>
                <th className="text-left px-2 py-1.5 font-medium">Close</th>
                <th className="text-right px-2 py-1.5 font-medium" title="Days since the current stage was reached">In stage</th>
                <th className="text-left px-2 py-1.5 font-medium">Manager</th>
                <th className="text-left px-2 py-1.5 font-medium">My role</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const isOpen = expanded.has(r.key);
                const badge = r.quoteState === 'quoted-mismatch' || r.quoteState === 'unquoted'
                  ? QUOTE_STATE_BADGE[r.quoteState]
                  : null;
                const recon = reconcileQuote(r.opp);
                const inv = INVOLVEMENT_META[r.involvement.status];
                return (
                  <Fragment key={r.key}>
                    <tr className="border-t border-border align-top">
                      <td className="px-1 py-1.5">
                        <button
                          type="button"
                          aria-label={isOpen ? 'Collapse detail' : 'Expand detail'}
                          onClick={() => toggleExpanded(r.key)}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </button>
                      </td>
                      <td className="px-2 py-1.5 font-medium">
                        <button type="button" onClick={() => openOpportunity(r.opp.id)} className="text-left hover:underline">
                          {r.opp.name}
                        </button>
                      </td>
                      <td className="px-2 py-1.5">{r.opp.repName}</td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap">
                        <span className="font-mono tabular-nums">{fmtMoney(r.opp.amount || 0)}</span>
                        {badge && (
                          <span
                            title={recon.likelyCause ?? undefined}
                            className={`ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${badge.tone}`}
                          >
                            {badge.label}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">{r.opp.stage}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{fmtDate(r.opp.closeDate)}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                        {r.daysInStage === null ? '—' : `${r.daysInStage}d`}
                      </td>
                      <td className="px-2 py-1.5">
                        <button
                          type="button"
                          onClick={() => cycleInvolvement(r)}
                          title="Click to cycle: not yet → scheduled → introduced"
                          className={`px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap ${inv.tone}`}
                        >
                          {inv.label}{r.involvement.date ? ` · ${fmtDate(r.involvement.date)}` : ''}
                        </button>
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          type="text"
                          defaultValue={r.involvement.note}
                          key={`${r.key}:${r.involvement.updatedAt}`}
                          placeholder="my role…"
                          onBlur={e => {
                            if (e.target.value !== r.involvement.note) setInvolvement(r.key, { note: e.target.value });
                          }}
                          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                          className="w-full min-w-[10rem] bg-transparent border-b border-transparent hover:border-border focus:border-ring text-xs py-0.5 focus:outline-none"
                        />
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-t border-border/50 bg-secondary/20">
                        <td />
                        <td colSpan={8} className="px-2 py-2 space-y-1.5">
                          <div className="flex items-center gap-2">
                            <span className="text-muted-foreground">Involvement date</span>
                            <input
                              type="date"
                              value={r.involvement.date}
                              onChange={e => setInvolvement(r.key, { date: e.target.value })}
                              className="rounded border border-border bg-background px-1.5 py-0.5 text-xs"
                            />
                            {r.involvement.updatedAt && (
                              <span className="text-[11px] text-muted-foreground">
                                updated {fmtDate(r.involvement.updatedAt)}
                              </span>
                            )}
                          </div>
                          {r.quoteState !== 'quoted-clean' && (
                            <p className="text-[11px] text-muted-foreground">
                              {r.quoteState === 'unquoted'
                                ? 'Unquoted — no Amount (Monthly) on the export, so Amount is a registration-time estimate.'
                                : recon.likelyCause ?? 'Amount and Amount (Monthly) disagree.'}
                            </p>
                          )}
                          <div>
                            <span className="text-muted-foreground">Manager Review Notes (Salesforce)</span>
                            <p className="whitespace-pre-wrap mt-0.5">
                              {r.opp.managerNote || <span className="text-muted-foreground">— none on the latest export —</span>}
                            </p>
                          </div>
                          {r.opp.nextStep && (
                            <div>
                              <span className="text-muted-foreground">Next step</span>
                              <p className="whitespace-pre-wrap mt-0.5">{r.opp.nextStep}</p>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Briefing */}
      <Dialog open={briefingOpen} onOpenChange={setBriefingOpen}>
        <DialogContent className="max-w-5xl overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between">
              <span>Friday Briefing</span>
              <Button variant="outline" size="sm" onClick={copyBriefing} className="gap-1.5 text-xs mr-6">
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? 'Copied' : 'Copy to clipboard'}
              </Button>
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 min-w-0">
            <div>
              <p className="text-xs font-medium mb-1">Rep commentary — this week</p>
              <p className="text-[11px] text-muted-foreground mb-2">
                Saved for the week of {period}; next week starts fresh.
              </p>
              <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                {repRows.map(r => (
                  <div key={r.repName} className="flex items-center gap-2">
                    <span className={`w-32 shrink-0 text-xs ${r.thin ? 'text-negative font-medium' : ''}`}>{r.repName}</span>
                    <input
                      type="text"
                      defaultValue={r.note}
                      key={`${period}:${r.repName}`}
                      placeholder={r.thin ? 'pipeline-building actions…' : 'activity / guidance…'}
                      onBlur={e => { if (e.target.value !== r.note) setRepNote(r.repName, e.target.value); }}
                      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                ))}
              </div>
            </div>
            <pre className="bg-secondary rounded-lg p-4 text-xs font-mono whitespace-pre overflow-auto max-w-full max-h-[50vh] text-foreground leading-relaxed">
              {briefingText}
            </pre>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
