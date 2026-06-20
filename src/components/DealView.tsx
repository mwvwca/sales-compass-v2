import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Search, Plus } from 'lucide-react';
import { useForecast } from '@/context/ForecastContext';
import type { ChangeLogEntry } from '@/types/forecast';
import { formatStageWithPct } from '@/lib/utils';
import { sfdcOpportunityUrl } from '@/lib/sfdc';
import { buildChangelogIndex, flagDeal } from '@/lib/dealRisk';
import { normSfId } from '@/lib/drMerge';
import { statusBadgeCls, statusLabel } from '@/lib/drStatus';
import { qualityFor, type NextStepCache } from '@/lib/nextStepClassify';
import { loadNextStepCache } from '@/lib/nextStepCacheApi';
import { loadCurrentSignalsByOpp, loadTranscripts } from '@/lib/transcriptsApi';
import { currentSignals, type Transcript, type TranscriptSignals } from '@/lib/transcripts';
import { FLAG_META, NextStepVerdictChip } from '@/components/riskChips';
import { SignalsView } from '@/components/SignalsView';
import { TranscriptDialog } from '@/components/TranscriptDialog';
import { Button } from '@/components/ui/button';

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

// Readable labels for changelog fields (not the raw keys).
const FIELD_LABEL: Record<ChangeLogEntry['field'], string> = {
  closeDate: 'Close date',
  amount: 'Amount',
  stage: 'Stage',
  classification: 'Classification',
  name: 'Name',
  repName: 'Rep',
  nextStep: 'Next step',
};

interface DealViewProps {
  selectedOppId: string | null;
  onSelect: (id: string) => void;
}

function HeaderField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className="text-sm font-medium mt-0.5">{children}</p>
    </div>
  );
}

function SectionCard({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border border-border rounded-md p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export default function DealView({ selectedOppId, onSelect }: DealViewProps) {
  const { opportunities, changelog, dealRegistrations } = useForecast();
  const [query, setQuery] = useState('');
  const [cache, setCache] = useState<NextStepCache>({});
  const [signalsByOpp, setSignalsByOpp] = useState<Record<string, TranscriptSignals>>({});
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Load the next-step classification cache + latest transcript signals once
  // (same pattern DealRiskView uses).
  useEffect(() => {
    let cancelled = false;
    loadNextStepCache().then(c => { if (!cancelled) setCache(c); }).catch(() => { /* offline → empty cache */ });
    loadCurrentSignalsByOpp().then(s => { if (!cancelled) setSignalsByOpp(s); }).catch(() => { /* offline → no signals */ });
    return () => { cancelled = true; };
  }, []);

  // Resolver: id first, then salesforceId, so callers can pass whichever they hold.
  const opp = useMemo(() => {
    if (!selectedOppId) return null;
    return opportunities.find(o => o.id === selectedOppId)
      ?? opportunities.find(o => o.salesforceId === selectedOppId)
      ?? null;
  }, [opportunities, selectedOppId]);

  // Conversation log for the resolved deal.
  const reloadTranscripts = useMemo(() => () => {
    if (!opp) { setTranscripts([]); return; }
    loadTranscripts(opp.id).then(setTranscripts).catch(() => setTranscripts([]));
    loadCurrentSignalsByOpp().then(setSignalsByOpp).catch(() => { /* keep prior */ });
  }, [opp]);

  useEffect(() => {
    let alive = true;
    if (!opp) { setTranscripts([]); return; }
    loadTranscripts(opp.id).then(ts => { if (alive) setTranscripts(ts); }).catch(() => { if (alive) setTranscripts([]); });
    return () => { alive = false; };
  }, [opp]);

  // Client-side search by name / account / salesforceId (opps are all in memory).
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return opportunities.filter(o =>
      o.name.toLowerCase().includes(q)
      || !!o.accountName?.toLowerCase().includes(q)
      || !!o.salesforceId?.toLowerCase().includes(q),
    ).slice(0, 50);
  }, [opportunities, query]);

  // One changelog index shared by the risk flags and the history timeline.
  const changelogIndex = useMemo(() => buildChangelogIndex(changelog), [changelog]);

  // Risk flags — EXACTLY as DealRiskView computes them (qualityFor + per-opp signals).
  const flags = useMemo(() => {
    if (!opp) return [];
    const today = new Date();
    return flagDeal(opp, changelogIndex, today, qualityFor(opp, cache), signalsByOpp[opp.id]);
  }, [opp, changelogIndex, cache, signalsByOpp]);

  // Change history for this deal, newest first.
  const historyEntries = useMemo(() => {
    if (!opp) return [];
    return [...(changelogIndex.get(opp.id) ?? [])]
      .sort((a, b) => new Date(b.importDate).getTime() - new Date(a.importDate).getTime());
  }, [opp, changelogIndex]);

  // Matched deal registration (joined on the normalized Salesforce id).
  const reg = useMemo(() => {
    if (!opp?.salesforceId) return undefined;
    return dealRegistrations.find(r => normSfId(r.opportunityId) === normSfId(opp.salesforceId));
  }, [opp, dealRegistrations]);

  const current = currentSignals(transcripts) ?? (opp ? signalsByOpp[opp.id] : null) ?? null;

  return (
    <div className="space-y-4">
      {/* SEARCH ------------------------------------------------------------ */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search deals by name, account, or Salesforce ID…"
          className="w-full rounded-md border border-border bg-background pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {query.trim() && (
        <div className="border border-border rounded-md divide-y divide-border max-h-72 overflow-y-auto">
          {results.length === 0 ? (
            <p className="text-xs text-muted-foreground px-3 py-3">No deals match “{query.trim()}”.</p>
          ) : results.map(o => (
            <button
              key={o.id}
              type="button"
              onClick={() => { onSelect(o.id); setQuery(''); }}
              className="w-full text-left px-3 py-2 hover:bg-secondary/40 transition-colors flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="text-xs font-medium truncate">{o.name}</div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {o.accountName ? `${o.accountName} · ` : ''}{formatStageWithPct(o.stage)} · {o.repName || '(unassigned)'}
                </div>
              </div>
              <span className="text-xs font-mono tabular-nums text-muted-foreground shrink-0">{fmt(o.amount || 0)}</span>
            </button>
          ))}
        </div>
      )}

      {/* DETAIL ----------------------------------------------------------- */}
      {!opp ? (
        <p className="text-xs text-muted-foreground py-10 text-center">
          Search for a deal above to open its 360.
        </p>
      ) : (
        <div className="space-y-4">
          {/* 1. HEADER */}
          <SectionCard
            title="Overview"
            action={opp.salesforceId
              ? (
                <a
                  href={sfdcOpportunityUrl(opp.salesforceId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open in Salesforce"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  Salesforce <ExternalLink size={12} />
                </a>
              )
              : undefined}
          >
            <div>
              <h2 className="text-lg font-semibold">{opp.name}</h2>
              {opp.accountName && <p className="text-xs text-muted-foreground">{opp.accountName}</p>}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <HeaderField label="Owner">{opp.repName || '(unassigned)'}</HeaderField>
              <HeaderField label="Amount">{fmt(opp.amount || 0)}</HeaderField>
              <HeaderField label="Stage">{formatStageWithPct(opp.stage)}</HeaderField>
              <HeaderField label="Probability">{Math.round((opp.probability ?? 0) * 100)}%</HeaderField>
              <HeaderField label="Close date">{opp.closeDate || '—'}</HeaderField>
              <HeaderField label="Classification">{opp.classification}</HeaderField>
            </div>
          </SectionCard>

          {/* 2. RISK */}
          <SectionCard title="Risk">
            {flags.length === 0 ? (
              <p className="text-xs text-muted-foreground">No risk flags on this deal.</p>
            ) : (
              <ul className="space-y-2">
                {flags.map((f, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] shrink-0 ${FLAG_META[f.kind].tone}`}>{FLAG_META[f.kind].label}</span>
                    <span className="text-xs text-muted-foreground">{f.why ?? f.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          {/* 3. NEXT STEP */}
          <SectionCard title="Next step">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-xs flex-1 min-w-0">{opp.nextStep?.trim() || <span className="text-muted-foreground italic">No next step set.</span>}</p>
              <NextStepVerdictChip id={opp.id} nextStep={opp.nextStep} cache={cache} />
            </div>
          </SectionCard>

          {/* 4. CONVERSATIONS */}
          <SectionCard
            title="Conversations"
            action={
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setDialogOpen(true)}>
                <Plus size={12} /> Add transcript
              </Button>
            }
          >
            {current && (
              <div className="rounded-md border border-border bg-secondary/30 p-3">
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Current signals</h4>
                <SignalsView signals={current} />
              </div>
            )}
            {transcripts.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No transcripts captured yet.</p>
            ) : (
              <div className="space-y-3">
                {transcripts.map(t => {
                  const d = new Date(t.createdAt);
                  const label = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
                  return (
                    <div key={t.id} className="border border-border rounded-md overflow-hidden">
                      <div className="bg-secondary/50 px-3 py-1.5 flex items-center justify-end text-[10px]">
                        <span className="text-muted-foreground font-mono">{label}</span>
                      </div>
                      <div className="px-3 py-2 space-y-2">
                        <SignalsView signals={t.signals} />
                        <p className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-4">{t.rawText}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </SectionCard>

          {/* 5. HISTORY */}
          <SectionCard title="History">
            {historyEntries.length === 0 ? (
              <p className="text-xs text-muted-foreground">No change history recorded for this deal.</p>
            ) : (
              <div className="space-y-2">
                {(() => {
                  const pushCount = historyEntries.filter(e => e.field === 'closeDate' && e.oldValue && e.newValue).length;
                  return pushCount > 0
                    ? <p className="text-xs text-muted-foreground">Close date pushed {pushCount} times</p>
                    : null;
                })()}
                <ul className="divide-y divide-border">
                  {historyEntries.map(e => (
                    <li key={e.id} className="py-1.5 flex items-center gap-2 text-xs flex-wrap">
                      <span className="font-mono text-muted-foreground">{e.importDate}</span>
                      <span className="text-muted-foreground">{FIELD_LABEL[e.field]}:</span>
                      <span className="font-mono text-muted-foreground line-through">{e.oldValue}</span>
                      <span className="text-muted-foreground">→</span>
                      <span className="font-mono font-medium">{e.newValue}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </SectionCard>

          {/* 6. DEAL REGISTRATION */}
          <SectionCard title="Deal registration">
            {!reg ? (
              <p className="text-xs text-muted-foreground">No matching deal registration.</p>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <HeaderField label="Status">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${statusBadgeCls(reg.status)}`}>{statusLabel(reg.status)}</span>
                </HeaderField>
                <HeaderField label="Registered">{reg.registeredDeal ? 'Yes' : 'No'}</HeaderField>
                <HeaderField label="SQL">{reg.isSql ? (reg.sqlDate ? `Yes · ${reg.sqlDate}` : 'Yes') : 'No'}</HeaderField>
                <HeaderField label="CAM">{reg.channelAccountManager || '(none)'}</HeaderField>
                <HeaderField label="Reseller">{reg.resolvedReseller || reg.resellerName || '(none)'}</HeaderField>
                <HeaderField label="Product">{reg.product || '(none)'}</HeaderField>
                <HeaderField label="Age (days)">{reg.ageDays}</HeaderField>
                <HeaderField label="Last activity">{reg.lastActivity || '(none)'}</HeaderField>
                <HeaderField label="Created">{reg.createdDate}</HeaderField>
              </div>
            )}
          </SectionCard>
        </div>
      )}

      <TranscriptDialog
        oppId={dialogOpen && opp ? opp.id : null}
        name={opp?.name}
        onClose={() => { setDialogOpen(false); reloadTranscripts(); }}
      />
    </div>
  );
}
