import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Plus, Trash2, Sparkles } from 'lucide-react';
import { useForecast } from '@/context/ForecastContext';
import { buildRepScorecard, type RepScorecard as RepScorecardData } from '@/lib/repScorecard';
import {
  weekKey, addActionItem, toggleActionItem, updateActionItem, removeActionItem,
  type ActionItem,
} from '@/lib/oneOnOnes';
import { loadOneOnOne, saveOneOnOne } from '@/lib/oneOnOnesApi';
import { getQuarter } from '@/types/forecast';
import { loadCurrentSignalsByOpp } from '@/lib/transcriptsApi';
import type { TranscriptSignals } from '@/lib/transcripts';
import { FLAG_META } from '@/components/riskChips';
import { openOpportunity } from '@/lib/openOpportunity';
import { coachOneOnOne } from '@/lib/coach1on1Api';
import type { CoachResult, CoachVerdict, CoachPayload } from '@/lib/coach1on1';

const fmtMoney = (n: number) => `$${Math.round(n || 0).toLocaleString('en-US')}`;
const fmtPct = (n: number | null | undefined, digits = 0) => (n == null ? '—' : `${(n * 100).toFixed(digits)}%`);
const fmtX = (n: number) => `${n.toFixed(1)}×`;

const VERDICT_META: Record<CoachVerdict, { label: string; tone: string }> = {
  'advances': { label: 'Advances', tone: 'bg-green-500/15 text-green-700 dark:text-green-400' },
  'activity': { label: 'Activity only', tone: 'bg-secondary/60 text-muted-foreground' },
  'missing-discovery': { label: 'Missing discovery', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  'unaddressed-risk': { label: 'Unaddressed risk', tone: 'bg-red-500/15 text-red-700 dark:text-red-400' },
};

function MetricCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="border border-border rounded-md p-3">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-semibold mt-1 ${tone ?? ''}`}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function OneOnOneCapture({ repId }: { repId: string }) {
  const week = useMemo(() => weekKey(new Date()), []);
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<ActionItem[]>([]);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const loadedRef = useRef(false);
  const skipSaveRef = useRef(true);

  // Load this week's row on mount / rep change (empty if none yet).
  useEffect(() => {
    let cancelled = false;
    loadedRef.current = false;
    skipSaveRef.current = true;
    setStatus('idle');
    loadOneOnOne(repId, week)
      .then(o => { if (!cancelled) { setNotes(o?.notes ?? ''); setItems(o?.actionItems ?? []); loadedRef.current = true; } })
      .catch(() => { if (!cancelled) { setNotes(''); setItems([]); loadedRef.current = true; } });
    return () => { cancelled = true; };
  }, [repId, week]);

  // Debounced auto-save on any change; skip the load-triggered state set.
  useEffect(() => {
    if (!loadedRef.current) return;
    if (skipSaveRef.current) { skipSaveRef.current = false; return; }
    setStatus('saving');
    const t = setTimeout(() => {
      saveOneOnOne({ repId, week, notes, actionItems: items })
        .then(() => setStatus('saved'))
        .catch(() => setStatus('idle'));
    }, 600);
    return () => clearTimeout(t);
  }, [notes, items, repId, week]);

  return (
    <Section title={`This Week's 1:1 · ${week}`}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">Notes &amp; action items auto-save to the cloud.</span>
        <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
          {status === 'saving' && <><Loader2 size={11} className="animate-spin" /> Saving…</>}
          {status === 'saved' && <><Check size={11} className="text-positive" /> Saved</>}
        </span>
      </div>
      <textarea
        value={notes}
        onChange={e => setNotes(e.target.value)}
        placeholder="Discussion notes, coaching, blockers…"
        rows={4}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <div className="space-y-1.5">
        {items.map(it => (
          <div key={it.id} className="flex items-center gap-2">
            <input type="checkbox" checked={it.done} onChange={() => setItems(prev => toggleActionItem(prev, it.id))} className="shrink-0" />
            <input
              value={it.text}
              onChange={e => setItems(prev => updateActionItem(prev, it.id, { text: e.target.value }))}
              placeholder="Action item"
              className={`flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring ${it.done ? 'line-through text-muted-foreground' : ''}`}
            />
            <input
              value={it.owner ?? ''}
              onChange={e => setItems(prev => updateActionItem(prev, it.id, { owner: e.target.value || undefined }))}
              placeholder="owner"
              className="w-20 rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <input
              type="date"
              value={it.due ?? ''}
              onChange={e => setItems(prev => updateActionItem(prev, it.id, { due: e.target.value || undefined }))}
              className="w-32 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <button type="button" onClick={() => setItems(prev => removeActionItem(prev, it.id))} title="Remove" className="text-muted-foreground hover:text-foreground shrink-0">
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setItems(prev => addActionItem(prev, ''))}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <Plus size={12} /> Add action item
        </button>
      </div>
    </Section>
  );
}

export default function RepScorecard() {
  const { reps, opportunities, changelog, dealRegistrations, managerQuotas } = useForecast();

  const pickReps = useMemo(
    () => reps.filter(r => r.isActive !== false).sort((a, b) => a.name.localeCompare(b.name)),
    [reps],
  );
  const [repId, setRepId] = useState<string>(() => pickReps[0]?.id ?? '');

  // Latest transcript signals per opp (read-only; captured from the opportunity list).
  const [signalsByOpp, setSignalsByOpp] = useState<Record<string, TranscriptSignals>>({});
  useEffect(() => {
    let cancelled = false;
    loadCurrentSignalsByOpp().then(s => { if (!cancelled) setSignalsByOpp(s); }).catch(() => { /* offline → no signals */ });
    return () => { cancelled = true; };
  }, []);

  const sc: RepScorecardData | null = useMemo(() => {
    if (!repId) return null;
    return buildRepScorecard(repId, { opportunities, changelog, dealRegistrations, managerQuotas, reps }, { signalsByOpp });
  }, [repId, opportunities, changelog, dealRegistrations, managerQuotas, reps, signalsByOpp]);


  // At-risk quarter filter (distinct close-date quarters present in the list).
  const [atRiskQuarter, setAtRiskQuarter] = useState<string>('all');
  const atRiskQuarters = useMemo(() => {
    const set = new Set<string>();
    for (const d of sc?.atRisk ?? []) {
      if (d.closeDate) { try { set.add(getQuarter(d.closeDate)); } catch { /* skip bad dates */ } }
    }
    return Array.from(set).sort();
  }, [sc]);
  const atRiskFiltered = useMemo(() => {
    const all = sc?.atRisk ?? [];
    if (atRiskQuarter === 'all') return all;
    return all.filter(d => {
      if (!d.closeDate) return false;
      try { return getQuarter(d.closeDate) === atRiskQuarter; } catch { return false; }
    });
  }, [sc, atRiskQuarter]);

  // ---- "Coach this 1:1": on-demand AI deal inspection (replaces the rule-based points) ----
  const [coach, setCoach] = useState<CoachResult | null>(null);
  const [coachStatus, setCoachStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  useEffect(() => { setCoach(null); setCoachStatus('idle'); }, [repId]);

  const runCoach = async () => {
    if (!sc) return;
    setCoachStatus('loading');
    const payload: CoachPayload = {
      rep: pickReps.find(r => r.id === repId)?.name ?? '',
      attainment: { quota: sc.attainment.quota, closedWon: sc.attainment.closedWon, gap: sc.attainment.gap, coverage: sc.attainment.coverage },
      forecast: { commit: sc.forecast.commit, bestCase: sc.forecast.bestCase, commitAccuracy: sc.forecast.commitAccuracy },
      deals: sc.atRisk.slice(0, 12).map(d => ({
        id: d.id,
        name: d.name,
        amount: d.amount,
        stage: d.stage,
        closeDate: d.closeDate ?? null,
        nextStep: d.nextStep,
        flags: d.flags.map(f => f.detail || f.kind),
        description: d.description ?? '',
        signals: signalsByOpp[d.id] ?? null,
      })),
    };
    try {
      const r = await coachOneOnOne(payload);
      setCoach(r);
      setCoachStatus('idle');
    } catch {
      setCoachStatus('error');
    }
  };

  if (pickReps.length === 0) {
    return <p className="text-xs text-muted-foreground py-6 text-center">No reps yet — add reps in Goals to build scorecards.</p>;
  }

  const coverageTone = !sc ? '' : sc.attainment.coverage >= 3 ? 'text-positive' : sc.attainment.coverage >= 1.5 ? 'text-upside' : 'text-negative';
  const accTone = !sc || sc.forecast.commitAccuracy == null ? 'text-muted-foreground' : sc.forecast.commitAccuracy >= 0.8 ? 'text-positive' : sc.forecast.commitAccuracy >= 0.5 ? 'text-upside' : 'text-negative';

  return (
    <div className="space-y-5">
      {/* Rep picker */}
      <div className="flex items-center gap-3">
        <label htmlFor="sc-rep" className="text-xs text-muted-foreground uppercase tracking-wide">Rep</label>
        <select
          id="sc-rep"
          value={repId}
          onChange={e => setRepId(e.target.value)}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        >
          {pickReps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>

      {!sc ? null : (
        <>
          {/* Attainment */}
          <Section title="Attainment">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricCard label="Quota" value={fmtMoney(sc.attainment.quota)} />
              <MetricCard label="Closed Won" value={fmtMoney(sc.attainment.closedWon)} tone="text-positive" />
              <MetricCard label="Gap" value={fmtMoney(sc.attainment.gap)} tone={sc.attainment.gap > 0 ? 'text-negative' : 'text-positive'} />
              <MetricCard label="Coverage" value={fmtX(sc.attainment.coverage)} sub="open ÷ gap" tone={coverageTone} />
            </div>
          </Section>

          {/* Forecast */}
          <Section title="Forecast">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <MetricCard label="Commit" value={fmtMoney(sc.forecast.commit)} />
              <MetricCard label="Best Case" value={fmtMoney(sc.forecast.bestCase)} sub="commit + upside" />
              <MetricCard label="Commit Accuracy" value={fmtPct(sc.forecast.commitAccuracy)} sub="resolved quarters" tone={accTone} />
            </div>
          </Section>

          {/* Pipeline */}
          <Section title="Pipeline">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricCard label="Open Deals" value={String(sc.pipeline.openCount)} sub={fmtMoney(sc.pipeline.openAmount)} />
              <MetricCard label="Open Amount" value={fmtMoney(sc.pipeline.openAmount)} />
              <MetricCard label="Stale" value={String(sc.pipeline.stale)} sub="30d+ no movement" tone={sc.pipeline.stale > 0 ? 'text-amber-600 dark:text-amber-400' : ''} />
              <MetricCard label="Slipped" value={String(sc.pipeline.slipped)} sub="this quarter" tone={sc.pipeline.slipped > 0 ? 'text-negative' : ''} />
            </div>
          </Section>

          {/* At-risk deals */}
          <Section title="At-Risk Deals">
            {sc.atRisk.length === 0 ? (
              <p className="text-xs text-muted-foreground">No open deals flagged at risk.</p>
            ) : (
              <>
                {atRiskQuarters.length > 0 && (
                  <select
                    value={atRiskQuarter}
                    onChange={e => setAtRiskQuarter(e.target.value)}
                    className="mb-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="all">All quarters</option>
                    {atRiskQuarters.map(q => <option key={q} value={q}>{q}</option>)}
                  </select>
                )}
                {atRiskFiltered.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No at-risk deals in this quarter.</p>
                ) : (
              <div className="border border-border rounded-md divide-y divide-border">
                {atRiskFiltered.map(d => (
                  <div key={d.id} className="px-3 py-2 flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium truncate">
                        <button type="button" onClick={() => openOpportunity(d.id)} className="text-left hover:underline">{d.name}</button>
                      </div>
                      <div className="text-[11px] text-muted-foreground">{d.stage} · {fmtMoney(d.amount)}</div>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {d.flags.map((f, i) => (
                          <span key={i} title={f.why ?? f.detail} className={`px-1.5 py-0.5 rounded text-[10px] ${FLAG_META[f.kind].tone}`}>
                            {FLAG_META[f.kind].label}{f.detail ? ` · ${f.detail}` : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="text-[11px] text-muted-foreground italic max-w-[45%] line-clamp-2 text-right" title={d.nextStep ?? undefined}>{d.nextStep ?? 'next step —'}</div>
                  </div>
                ))}
              </div>
                )}
              </>
            )}
          </Section>

          {/* Channel quality */}
          <Section title="Channel Quality">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricCard label="SQL Rate" value={fmtPct(sc.channel.sqlRate)} />
              <MetricCard label="Rejection" value={fmtPct(sc.channel.rejection)} tone={sc.channel.rejection > 0.3 ? 'text-negative' : ''} />
              <MetricCard label="Unworked" value={fmtPct(sc.channel.unworked)} tone={sc.channel.unworked > 0.3 ? 'text-amber-600 dark:text-amber-400' : ''} />
              <MetricCard label="Padding" value={String(sc.channel.padding)} sub="padded regs" />
            </div>
          </Section>

          {/* 1:1 Coaching (on-demand AI deal inspection; replaces the rule-based points) */}
          <Section title="1:1 Coaching">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted-foreground">
                {coach ? 'Crux, next-step verdict, and a challenge per at-risk deal.' : 'Inspect the at-risk book: crux, next-step verdict, and a challenge per deal.'}
              </span>
              <button
                type="button"
                onClick={runCoach}
                disabled={coachStatus === 'loading' || sc.atRisk.length === 0}
                className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
              >
                {coachStatus === 'loading' ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                {coach ? 'Regenerate' : 'Coach this 1:1'}
              </button>
            </div>

            {coachStatus === 'error' && <p className="text-xs text-negative">Coaching failed to generate. Try again.</p>}

            {coach ? (
              <div className="space-y-3">
                {coach.themes.length > 0 && (
                  <div className="border border-border rounded-md p-3 space-y-1">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Patterns</p>
                    <ul className="list-disc pl-5 space-y-1">
                      {coach.themes.map((t, i) => <li key={i} className="text-xs">{t}</li>)}
                    </ul>
                  </div>
                )}
                {(() => {
                  const byId = new Map(coach.deals.map(d => [d.id, d]));
                  const rows = sc.atRisk.filter(d => byId.has(d.id));
                  if (rows.length === 0) return <p className="text-xs text-muted-foreground">No per-deal coaching returned.</p>;
                  return (
                    <div className="space-y-2">
                      {rows.map(d => {
                        const c = byId.get(d.id)!;
                        return (
                          <div key={d.id} className="border border-border rounded-md p-3 space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <button type="button" onClick={() => openOpportunity(d.id)} className="text-xs font-medium text-left hover:underline truncate">{d.name}</button>
                              <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] ${VERDICT_META[c.verdict].tone}`}>{VERDICT_META[c.verdict].label}</span>
                            </div>
                            {c.crux && <p className="text-xs"><span className="text-muted-foreground">Crux: </span>{c.crux}</p>}
                            {c.challenge && <p className="text-xs"><span className="text-muted-foreground">Challenge: </span>{c.challenge}</p>}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            ) : (
              sc.talkingPoints.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nothing flagged yet. Run the coach for deal-level prep.</p>
              ) : (
                <ul className="list-disc pl-5 space-y-1">
                  {sc.talkingPoints.map((p, i) => <li key={i} className="text-xs">{p}</li>)}
                </ul>
              )
            )}
          </Section>

          {/* Stage 2 — 1:1 capture (notes + action items), cloud-persisted */}
          <OneOnOneCapture repId={repId} />
        </>
      )}
    </div>
  );
}
