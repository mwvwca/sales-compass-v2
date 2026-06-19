import { useMemo, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { buildRepScorecard, type RepScorecard as RepScorecardData, type RiskFlagKind } from '@/lib/repScorecard';

const fmtMoney = (n: number) => `$${Math.round(n || 0).toLocaleString('en-US')}`;
const fmtPct = (n: number | null | undefined, digits = 0) => (n == null ? '—' : `${(n * 100).toFixed(digits)}%`);
const fmtX = (n: number) => `${n.toFixed(1)}×`;

function MetricCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="border border-border rounded-md p-3">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-semibold mt-1 ${tone ?? ''}`}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

const FLAG_META: Record<RiskFlagKind, { label: string; tone: string }> = {
  pushed: { label: 'Pushed', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  stalled: { label: 'Stalled', tone: 'bg-red-500/15 text-red-700 dark:text-red-400' },
  under_qualified: { label: 'Under-qualified', tone: 'bg-blue-500/15 text-blue-700 dark:text-blue-400' },
  no_next_step: { label: 'No next step', tone: 'bg-secondary/40 text-muted-foreground' },
  single_threaded: { label: 'Single-threaded', tone: 'bg-secondary/40 text-muted-foreground' },
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

export default function RepScorecard() {
  const { reps, opportunities, changelog, dealRegistrations, managerQuotas } = useForecast();

  const pickReps = useMemo(
    () => reps.filter(r => r.isActive !== false).sort((a, b) => a.name.localeCompare(b.name)),
    [reps],
  );
  const [repId, setRepId] = useState<string>(() => pickReps[0]?.id ?? '');

  const sc: RepScorecardData | null = useMemo(() => {
    if (!repId) return null;
    return buildRepScorecard(repId, { opportunities, changelog, dealRegistrations, managerQuotas, reps });
  }, [repId, opportunities, changelog, dealRegistrations, managerQuotas, reps]);

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
              <div className="border border-border rounded-md divide-y divide-border">
                {sc.atRisk.map(d => (
                  <div key={d.id} className="px-3 py-2 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-medium truncate">{d.name}</div>
                      <div className="text-[11px] text-muted-foreground">{d.stage} · {fmtMoney(d.amount)}</div>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {d.flags.map((f, i) => (
                          <span key={i} title={f.detail} className={`px-1.5 py-0.5 rounded text-[10px] ${FLAG_META[f.kind].tone}`}>
                            {FLAG_META[f.kind].label}{f.detail ? ` · ${f.detail}` : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                    {/* nextStep is Stage-2 data — shown as a placeholder until captured */}
                    <div className="text-[11px] text-muted-foreground shrink-0 italic">{d.nextStep ?? 'next step —'}</div>
                  </div>
                ))}
              </div>
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

          {/* Talking points */}
          <Section title="Talking Points">
            {sc.talkingPoints.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing flagged — no prep points generated.</p>
            ) : (
              <ul className="list-disc pl-5 space-y-1">
                {sc.talkingPoints.map((p, i) => <li key={i} className="text-xs">{p}</li>)}
              </ul>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
