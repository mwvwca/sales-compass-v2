import { useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { useForecast } from '@/context/ForecastContext';
import { buildChangelogIndex, dealRiskSignals, flagDeal, type RiskFlag, type RiskFlagKind } from '@/lib/dealRisk';
import { selectChangedDeals, mergeClassifications, qualityFor, type NextStepCache } from '@/lib/nextStepClassify';
import { classifyNextSteps } from '@/lib/nextStepClassifyApi';
import { loadNextStepCache, saveNextStepCache } from '@/lib/nextStepCacheApi';
import { loadCurrentSignalsByOpp } from '@/lib/transcriptsApi';
import type { TranscriptSignals } from '@/lib/transcripts';
import { FLAG_META } from '@/components/riskChips';
import { openOpportunity } from '@/lib/openOpportunity';

const fmtMoney = (n: number) => `$${Math.round(n || 0).toLocaleString('en-US')}`;
const TERMINAL = new Set(['closed_won', 'lost', 'omitted', 'rejected']);

// Only the populated flag kinds are filterable.
const FILTER_KINDS: RiskFlagKind[] = ['pushed', 'stalled', 'under_qualified', 'no_next_step', 'vague_next_step', 'single_threaded', 'negative_sentiment'];

interface RiskRow {
  id: string;
  rep: string;
  name: string;
  salesforceId?: string;
  nextStep?: string;
  amount: number;
  stage: string;
  daysSinceMovement: number;
  pushCount: number;
  flags: RiskFlag[];
}

export default function DealRiskView() {
  const { opportunities, changelog } = useForecast();
  const [repFilter, setRepFilter] = useState<string>('all');
  const [activeKinds, setActiveKinds] = useState<Set<RiskFlagKind>>(() => new Set(FILTER_KINDS));
  const [cache, setCache] = useState<NextStepCache>({});
  const [signalsByOpp, setSignalsByOpp] = useState<Record<string, TranscriptSignals>>({});
  const [classifyState, setClassifyState] = useState<'idle' | 'running' | 'error'>('idle');

  // Load the persisted classification cache + latest transcript signals once.
  useEffect(() => {
    let cancelled = false;
    loadNextStepCache().then(c => { if (!cancelled) setCache(c); }).catch(() => { /* offline → empty cache */ });
    loadCurrentSignalsByOpp().then(s => { if (!cancelled) setSignalsByOpp(s); }).catch(() => { /* offline → no signals */ });
    return () => { cancelled = true; };
  }, []);

  const rows = useMemo<RiskRow[]>(() => {
    const today = new Date();
    const index = buildChangelogIndex(changelog);
    const out: RiskRow[] = [];
    for (const o of opportunities) {
      if (TERMINAL.has(o.classification)) continue; // open deals only
      const flags = flagDeal(o, index, today, qualityFor(o, cache), signalsByOpp[o.id]);
      if (flags.length === 0) continue;
      const { pushCount, daysSinceMovement } = dealRiskSignals(o, index, today);
      out.push({
        id: o.id, rep: o.repName || '(unassigned)', name: o.name, salesforceId: o.salesforceId, nextStep: o.nextStep, amount: o.amount || 0,
        stage: o.stage, daysSinceMovement, pushCount, flags,
      });
    }
    out.sort((a, b) => b.amount - a.amount); // default sort: amount desc
    return out;
  }, [opportunities, changelog, cache, signalsByOpp]);

  // Open deals whose non-empty next step changed since last classification — the
  // only ones an AI call would spend on.
  const pendingClassify = useMemo(
    () => selectChangedDeals(opportunities, cache),
    [opportunities, cache],
  );

  const runClassify = async () => {
    if (pendingClassify.length === 0 || classifyState === 'running') return;
    setClassifyState('running');
    try {
      const results = await classifyNextSteps(pendingClassify);
      const merged = mergeClassifications(cache, pendingClassify, results);
      setCache(merged);
      await saveNextStepCache(merged);
      setClassifyState('idle');
    } catch {
      setClassifyState('error');
    }
  };

  const repOptions = useMemo(
    () => Array.from(new Set(rows.map(r => r.rep))).sort((a, b) => a.localeCompare(b)),
    [rows],
  );

  const filtered = useMemo(
    () => rows.filter(r =>
      (repFilter === 'all' || r.rep === repFilter) &&
      r.flags.some(f => activeKinds.has(f.kind)),
    ),
    [rows, repFilter, activeKinds],
  );

  const totalAtRisk = filtered.reduce((s, r) => s + r.amount, 0);

  const toggleKind = (k: RiskFlagKind) => setActiveKinds(prev => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  return (
    <div className="space-y-4">
      {/* Header: count + $ at risk + classify trigger */}
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="text-2xl font-semibold">{filtered.length}</span>
        <span className="text-xs text-muted-foreground uppercase tracking-wide">deals at risk</span>
        <span className="text-sm font-medium text-negative">{fmtMoney(totalAtRisk)}</span>
        <span className="text-xs text-muted-foreground">at risk</span>
        <div className="ml-auto flex items-center gap-2">
          {classifyState === 'error' && <span className="text-[11px] text-negative">Classify failed</span>}
          <button
            type="button"
            onClick={runClassify}
            disabled={pendingClassify.length === 0 || classifyState === 'running'}
            title={pendingClassify.length === 0 ? 'All next steps already classified' : `Classify ${pendingClassify.length} changed next step(s)`}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-secondary/40 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {classifyState === 'running' ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {classifyState === 'running' ? 'Classifying…' : `Classify next steps${pendingClassify.length ? ` (${pendingClassify.length})` : ''}`}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={repFilter}
          onChange={e => setRepFilter(e.target.value)}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="all">All reps</option>
          {repOptions.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <div className="inline-flex gap-1">
          {FILTER_KINDS.map(k => (
            <button
              key={k}
              type="button"
              onClick={() => toggleKind(k)}
              className={`px-2 py-1 rounded text-[11px] border transition-colors ${activeKinds.has(k) ? `${FLAG_META[k].tone} border-transparent` : 'border-border text-muted-foreground hover:text-foreground'}`}
            >
              {FLAG_META[k].label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground py-6 text-center">No open deals match these filters.</p>
      ) : (
        <div className="overflow-x-auto border border-border rounded-md">
          <table className="w-full text-xs">
            <thead className="bg-secondary/40 text-muted-foreground">
              <tr>
                <th className="text-left px-2 py-1.5 font-medium">Rep</th>
                <th className="text-left px-2 py-1.5 font-medium">Deal</th>
                <th className="text-right px-2 py-1.5 font-medium">Amount</th>
                <th className="text-left px-2 py-1.5 font-medium">Stage</th>
                <th className="text-right px-2 py-1.5 font-medium">Days idle</th>
                <th className="text-right px-2 py-1.5 font-medium">Pushes</th>
                <th className="text-left px-2 py-1.5 font-medium">Flags</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-2 py-1.5">{r.rep}</td>
                  <td className="px-2 py-1.5 font-medium">
                    <button type="button" onClick={() => openOpportunity(r.id)} className="text-left hover:underline">{r.name}</button>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtMoney(r.amount)}</td>
                  <td className="px-2 py-1.5">{r.stage}</td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">{r.daysSinceMovement}d</td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">{r.pushCount}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      {r.flags.map((f, i) => (
                        <span key={i} title={f.why ?? f.detail} className={`px-1.5 py-0.5 rounded text-[10px] ${FLAG_META[f.kind].tone}`}>
                          {FLAG_META[f.kind].label}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
