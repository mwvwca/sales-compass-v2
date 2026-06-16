import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Mail, Copy, RefreshCw, ExternalLink, Loader2, Anchor, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import type { DealRegistration } from '@/types/forecast';
import {
  classifyCleanup,
  analyzeAnchors,
  groupByCAM,
  buildCleanupEmailPrompt,
  buildCleanupEmail,
  type CamCleanupGroup,
  type CleanupStage,
  type CleanupClassification,
  type AnchorRole,
} from '@/lib/drCleanup';

const STAGE_META: Record<CleanupStage, { label: string; tone: string; short: string }> = {
  monitoring: { label: 'Monitoring', tone: 'bg-secondary/40 text-muted-foreground', short: 'Monitor' },
  partner_outreach: { label: 'Partner Outreach', tone: 'bg-blue-500/15 text-blue-700 dark:text-blue-400', short: 'Outreach' },
  final_notice: { label: 'Final Notice', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400', short: 'Final Notice' },
  ready_to_close: { label: 'Ready to Close', tone: 'bg-red-500/15 text-red-700 dark:text-red-400', short: 'Close' },
  exempt: { label: 'Exempt (Anchor)', tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400', short: 'Anchor' },
};

const ROLE_META: Record<AnchorRole, { label: string; tone: string }> = {
  anchor: { label: 'Anchor', tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' },
  satellite: { label: 'Satellite', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  single: { label: 'Single', tone: 'bg-secondary/40 text-muted-foreground' },
  orphan_cluster: { label: 'Orphan Cluster', tone: 'bg-red-500/15 text-red-700 dark:text-red-400' },
};

function extractSubject(emailText: string): { subject: string; body: string } {
  const m = emailText.match(/^\s*Subject:\s*(.+)\s*\n+/i);
  if (m) return { subject: m[1].trim(), body: emailText.slice(m[0].length).trim() };
  return { subject: 'Pipeline Review — Deal Registration Cleanup', body: emailText.trim() };
}

interface Props {
  dealRegistrations: DealRegistration[];
}

interface StageGroup {
  stage: CleanupStage | 'immediate';
  title: string;
  description: string;
  tone: string;
  items: CleanupClassification[];
  defaultOpen: boolean;
}

export default function DrCleanupPlanSection({ dealRegistrations }: Props) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [openCam, setOpenCam] = useState<string | null>(null);
  const [emails, setEmails] = useState<Record<string, string>>({});
  const [loadingCam, setLoadingCam] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number } | null>(null);
  const [openContext, setOpenContext] = useState<string | null>(null);

  // Exclude DRs in terminal states — they don't need cleanup
  const eligibleDrs = useMemo(
    () => dealRegistrations.filter(d =>
      d.status !== 'closed_won' &&
      d.status !== 'closed_lost' &&
      d.status !== 'rejected' &&
      d.status !== 'withdrawn'
    ),
    [dealRegistrations]
  );

  const { items, groups, stageBuckets, anchorsExempt, immediateCount } = useMemo(() => {
    const cls = classifyCleanup(eligibleDrs);
    const gs = groupByCAM(cls);
    const exempt = cls.filter(c => c.cleanupStage === 'exempt').length;
    const immediate = cls.filter(c => c.immediateAction).length;

    const buckets: StageGroup[] = [
      {
        stage: 'immediate',
        title: 'Immediate AE Action',
        description: 'Multi-registration accounts with no activity on any deal. AE must engage or close all.',
        tone: 'text-red-700 dark:text-red-400',
        items: cls.filter(c => c.immediateAction),
        defaultOpen: true,
      },
      {
        stage: 'ready_to_close',
        title: 'Ready to Close',
        description: '45+ days with no response. Close these registrations.',
        tone: 'text-red-700 dark:text-red-400',
        items: cls.filter(c => c.cleanupStage === 'ready_to_close' && !c.immediateAction),
        defaultOpen: true,
      },
      {
        stage: 'final_notice',
        title: 'Final Notice',
        description: '30-44 days. Send final warning email.',
        tone: 'text-amber-700 dark:text-amber-400',
        items: cls.filter(c => c.cleanupStage === 'final_notice' && !c.immediateAction),
        defaultOpen: true,
      },
      {
        stage: 'partner_outreach',
        title: 'Partner Outreach',
        description: '15-29 days. Send partner rep email, CC CAM.',
        tone: 'text-blue-700 dark:text-blue-400',
        items: cls.filter(c => c.cleanupStage === 'partner_outreach' && !c.immediateAction),
        defaultOpen: true,
      },
      {
        stage: 'monitoring',
        title: 'Monitoring',
        description: 'Within 15-day window. No action yet.',
        tone: 'text-muted-foreground',
        items: cls.filter(c => c.cleanupStage === 'monitoring'),
        defaultOpen: false,
      },
    ];

    return { items: cls, groups: gs, stageBuckets: buckets, anchorsExempt: exempt, immediateCount: immediate };
  }, [eligibleDrs]);

  const anchorMap = useMemo(() => analyzeAnchors(eligibleDrs), [eligibleDrs]);
  const drsById = useMemo(() => {
    const m = new Map<string, DealRegistration>();
    for (const d of dealRegistrations) m.set(d.opportunityId, d);
    return m;
  }, [dealRegistrations]);

  const generateForCam = async (group: CamCleanupGroup): Promise<string | null> => {
    const { subject, body } = buildCleanupEmail(group);
    const text = `Subject: ${subject}\n\n${body}`;
    setEmails(prev => ({ ...prev, [group.cam]: text }));
    return text;
  };

  const handleGenerate = async (group: CamCleanupGroup) => {
    setLoadingCam(group.cam);
    await generateForCam(group);
    setLoadingCam(null);
  };

  const handleGenerateAll = async () => {
    setBulkProgress({ current: 0, total: groups.length });
    for (let i = 0; i < groups.length; i++) {
      setBulkProgress({ current: i + 1, total: groups.length });
      await generateForCam(groups[i]);
      if (i < groups.length - 1) await new Promise(r => setTimeout(r, 1000));
    }
    setBulkProgress(null);
    toast({ title: 'All emails generated', description: `${groups.length} CAM emails ready to review.` });
  };

  const copyEmail = async (group: CamCleanupGroup) => {
    const raw = emails[group.cam];
    if (!raw) return;
    const { subject, body } = extractSubject(raw);
    const payload = `To: ${group.camEmail}\nCC: ${group.aeEmails.join(', ')}\nSubject: ${subject}\n\n${body}`;
    try {
      await navigator.clipboard.writeText(payload);
      toast({ title: 'Copied to clipboard' });
    } catch {
      toast({ title: 'Copy failed', variant: 'destructive' });
    }
  };

  const openInMail = (group: CamCleanupGroup) => {
    const raw = emails[group.cam] || '';
    const { subject, body } = extractSubject(raw);
    const finalSubject = subject || `Pipeline Review — ${group.deals.length} Deal Registrations`;
    const link = `mailto:${group.camEmail}?cc=${encodeURIComponent(group.aeEmails.join(','))}&subject=${encodeURIComponent(finalSubject)}&body=${encodeURIComponent(body)}`;
    window.open(link);
  };

  if (dealRegistrations.length === 0) return null;

  const totalActionable = items.filter(i => i.cleanupStage !== 'exempt').length;
  const counts = {
    ready_to_close: items.filter(i => i.cleanupStage === 'ready_to_close' && !i.immediateAction).length,
    final_notice: items.filter(i => i.cleanupStage === 'final_notice' && !i.immediateAction).length,
    partner_outreach: items.filter(i => i.cleanupStage === 'partner_outreach' && !i.immediateAction).length,
    monitoring: items.filter(i => i.cleanupStage === 'monitoring').length,
  };

  return (
    <section className="border border-border rounded-md">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full px-3 py-2 border-b border-border flex items-center justify-between gap-3 hover:bg-secondary/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <div className="text-left">
            <h3 className="text-xs font-semibold">Pipeline Cleanup Plan</h3>
            <p className="text-[11px] text-muted-foreground">15/15/final notice cadence. Anchor registrations on multi-reg accounts are exempt.</p>
          </div>
        </div>
        <span className="text-[11px] text-muted-foreground">{totalActionable} actionable · {groups.length} CAMs</span>
      </button>

      {expanded && (
        <div className="p-4 space-y-4">
          {totalActionable === 0 && immediateCount === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">
              No cleanup actions required — pipeline is healthy.
            </p>
          ) : (
            <>
              {/* Summary bar */}
              <div className="border border-border rounded-md p-3 space-y-2 bg-secondary/20">
                <p className="text-xs font-medium">
                  Cleanup Pipeline — {totalActionable} registration{totalActionable === 1 ? '' : 's'} need action
                </p>
                <div className="flex items-center gap-3 text-[11px] flex-wrap">
                  <span className="text-red-700 dark:text-red-400 inline-flex items-center gap-1">
                    <AlertTriangle size={11} /> Immediate: {immediateCount}
                  </span>
                  <span className="text-red-700 dark:text-red-400">Ready to Close: {counts.ready_to_close}</span>
                  <span className="text-amber-700 dark:text-amber-400">Final Notice: {counts.final_notice}</span>
                  <span className="text-blue-700 dark:text-blue-400">Partner Outreach: {counts.partner_outreach}</span>
                  <span className="text-muted-foreground">Monitoring: {counts.monitoring}</span>
                </div>
                <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
                  {anchorsExempt > 0 ? (
                    <p className="text-[11px] text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
                      <Anchor size={11} /> {anchorsExempt} anchor registration{anchorsExempt === 1 ? '' : 's'} exempt — actively-worked deals on multi-registration accounts.
                    </p>
                  ) : <span />}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleGenerateAll}
                    disabled={!!bulkProgress || !!loadingCam || groups.length === 0}
                    className="h-8 text-xs"
                  >
                    {bulkProgress ? (
                      <><Loader2 size={12} className="animate-spin" />Generating {bulkProgress.current} of {bulkProgress.total}…</>
                    ) : (
                      <><Mail size={12} />Generate All Emails</>
                    )}
                  </Button>
                </div>
              </div>

              {/* Stage groups */}
              <div className="space-y-3">
                {stageBuckets.filter(b => b.items.length > 0).map(bucket => (
                  <StageGroupBlock
                    key={bucket.stage}
                    bucket={bucket}
                    anchorMap={anchorMap}
                    drsById={drsById}
                    openContext={openContext}
                    setOpenContext={setOpenContext}
                  />
                ))}
              </div>

              {/* Per-CAM email accordion */}
              {groups.length > 0 && (
                <div className="space-y-2 pt-2">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Email Drafts by CAM</h4>
                  {groups.map(group => {
                    const isOpen = openCam === group.cam;
                    const isLoading = loadingCam === group.cam;
                    const emailText = emails[group.cam];
                    const parsed = emailText ? extractSubject(emailText) : null;
                    return (
                      <div key={group.cam} className="border border-border rounded-md">
                        <div className="flex items-center justify-between gap-3 px-3 py-2 flex-wrap">
                          <button
                            onClick={() => setOpenCam(isOpen ? null : group.cam)}
                            className="flex items-center gap-2 text-left flex-1 min-w-0"
                          >
                            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            <div className="min-w-0">
                              <div className="text-xs font-medium flex items-center gap-3 flex-wrap">
                                <span>{group.cam}</span>
                                <span className="text-muted-foreground">·</span>
                                <span>{group.deals.length} deal{group.deals.length === 1 ? '' : 's'}</span>
                                {group.immediateCount > 0 && (
                                  <span className="text-red-700 dark:text-red-400">⚠ {group.immediateCount} immediate</span>
                                )}
                                {group.stageCounts.ready_to_close > 0 && (
                                  <span className="text-red-700 dark:text-red-400">Close: {group.stageCounts.ready_to_close}</span>
                                )}
                                {group.stageCounts.final_notice > 0 && (
                                  <span className="text-amber-700 dark:text-amber-400">Final: {group.stageCounts.final_notice}</span>
                                )}
                                {group.stageCounts.partner_outreach > 0 && (
                                  <span className="text-blue-700 dark:text-blue-400">Outreach: {group.stageCounts.partner_outreach}</span>
                                )}
                              </div>
                              <div className="text-[11px] text-muted-foreground truncate">
                                {group.camEmail || '(no CAM email)'} · CC: {group.aeEmails.join(', ') || '(no AE)'}
                              </div>
                            </div>
                          </button>
                          <div className="flex items-center gap-2 shrink-0">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              onClick={() => handleGenerate(group)}
                              disabled={isLoading || !!bulkProgress}
                            >
                              {isLoading ? <Loader2 size={12} className="animate-spin" /> : <Mail size={12} />}
                              {emailText ? 'Regenerate' : 'Generate Email'}
                            </Button>
                            {emailText && (
                              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => copyEmail(group)}>
                                <Copy size={12} /> Copy
                              </Button>
                            )}
                          </div>
                        </div>

                        {isOpen && (
                          <div className="border-t border-border bg-secondary/10 p-3 space-y-2">
                            <div className="text-[11px] font-mono space-y-0.5">
                              <div><span className="text-muted-foreground">To:</span> {group.camEmail || '(no CAM email)'}</div>
                              <div><span className="text-muted-foreground">CC:</span> {group.aeEmails.join(', ') || '(none)'}</div>
                              <div><span className="text-muted-foreground">Subject:</span> {parsed?.subject || `Pipeline Review — ${group.deals.length} Deal Registrations`}</div>
                            </div>
                            {parsed ? (
                              <pre className="text-xs font-mono whitespace-pre-wrap bg-background border border-border rounded p-3 max-h-96 overflow-auto">
                                {parsed.body}
                              </pre>
                            ) : (
                              <p className="text-[11px] text-muted-foreground">
                                Click "Generate Email" to draft a message, or use the address fields above to compose manually.
                              </p>
                            )}
                            <div className="flex items-center gap-2 flex-wrap">
                              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => copyEmail(group)} disabled={!emailText}>
                                <Copy size={12} /> Copy to Clipboard
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => handleGenerate(group)} disabled={isLoading || !!bulkProgress}>
                                <RefreshCw size={12} /> Regenerate
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => openInMail(group)}>
                                <ExternalLink size={12} /> Open in Mail
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ---------- Stage group block ----------

function StageGroupBlock({
  bucket,
  anchorMap,
  drsById,
  openContext,
  setOpenContext,
}: {
  bucket: StageGroup;
  anchorMap: Map<string, ReturnType<typeof analyzeAnchors> extends Map<string, infer V> ? V : never>;
  drsById: Map<string, DealRegistration>;
  openContext: string | null;
  setOpenContext: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(bucket.defaultOpen);
  return (
    <div className="border border-border rounded-md">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full px-3 py-2 flex items-center justify-between gap-3 hover:bg-secondary/30 transition-colors"
      >
        <div className="flex items-center gap-2 text-left">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <div>
            <div className={`text-xs font-semibold ${bucket.tone}`}>
              {bucket.stage === 'immediate' && '⚠ '}{bucket.title} — {bucket.items.length}
            </div>
            <div className="text-[11px] text-muted-foreground">{bucket.description}</div>
          </div>
        </div>
      </button>
      {open && (
        <div className="border-t border-border overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-secondary/30 text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-1.5 font-medium">Opportunity</th>
                <th className="text-left px-3 py-1.5 font-medium">Account</th>
                <th className="text-left px-3 py-1.5 font-medium">AE</th>
                <th className="text-left px-3 py-1.5 font-medium">CAM</th>
                <th className="text-left px-3 py-1.5 font-medium">Role</th>
                <th className="text-right px-3 py-1.5 font-medium">Days Since Activity</th>
                <th className="text-left px-3 py-1.5 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {bucket.items.map(item => {
                const key = `${(item.dr.accountName || '').toLowerCase().trim()}::${item.dr.channelAccountManager || ''}`;
                const analysis = anchorMap.get(key);
                const isMulti = !!analysis;
                const ctxOpen = openContext === item.dr.opportunityId;
                return (
                  <Fragment key={item.dr.opportunityId}>
                    <tr className="border-t border-border/60 align-top">
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-1">
                          {isMulti && (
                            <button
                              className="text-muted-foreground hover:text-foreground"
                              onClick={() => setOpenContext(ctxOpen ? null : item.dr.opportunityId)}
                              title="Show other registrations on this account"
                            >
                              {ctxOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                            </button>
                          )}
                          <span>{item.dr.opportunityName}</span>
                        </div>
                      </td>
                      <td className="px-3 py-1.5">{item.dr.accountName}</td>
                      <td className="px-3 py-1.5">{item.dr.repName}</td>
                      <td className="px-3 py-1.5">{item.dr.channelAccountManager || '—'}</td>
                      <td className="px-3 py-1.5">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${ROLE_META[item.anchorRole].tone}`}>
                          {ROLE_META[item.anchorRole].label}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{item.daysSinceActivity}d</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{item.recommendedAction}</td>
                    </tr>
                    {ctxOpen && analysis && (
                      <tr className="bg-secondary/20">
                        <td colSpan={7} className="px-3 py-2">
                          <MultiRegContext analysis={analysis} drsById={drsById} currentId={item.dr.opportunityId} />
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
    </div>
  );
}

function Fragment({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function MultiRegContext({
  analysis,
  drsById,
  currentId,
}: {
  analysis: { accountName: string; cam: string; totalRegs: number; anchorId: string | null; satelliteIds: string[]; hasNoActivityAnywhere: boolean };
  drsById: Map<string, DealRegistration>;
  currentId: string;
}) {
  const anchor = analysis.anchorId ? drsById.get(analysis.anchorId) : null;
  const satellites = analysis.satelliteIds.map(id => drsById.get(id)).filter(Boolean) as DealRegistration[];
  const otherSatellites = satellites.filter(s => s.opportunityId !== currentId);

  const daysAgo = (iso?: string) => {
    if (!iso) return null;
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    return `${d}d ago`;
  };

  return (
    <div className="text-[11px] space-y-1 text-foreground/90">
      <div className="font-medium">
        Account: {analysis.accountName} / CAM: {analysis.cam || '—'} — {analysis.totalRegs} registrations
      </div>
      {analysis.hasNoActivityAnywhere ? (
        <div className="text-red-700 dark:text-red-400">⚠ No activity on any registration in this cluster.</div>
      ) : anchor ? (
        <div>
          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
            <Anchor size={10} /> Anchor:
          </span>{' '}
          "{anchor.opportunityName}"{' '}
          <span className="text-muted-foreground">
            (last activity {daysAgo(anchor.lastActivity) ?? 'unknown'})
          </span>
        </div>
      ) : null}
      <div>
        • This deal: "{drsById.get(currentId)?.opportunityName}" ({currentId === analysis.anchorId ? 'anchor' : analysis.hasNoActivityAnywhere ? 'orphan' : 'satellite'})
      </div>
      {otherSatellites.length > 0 && (
        <div className="text-muted-foreground">
          • {otherSatellites.length} other {otherSatellites.length === 1 ? 'satellite' : 'satellites'}:{' '}
          {otherSatellites.slice(0, 3).map(s => `"${s.opportunityName}"`).join(', ')}
          {otherSatellites.length > 3 ? `, +${otherSatellites.length - 3} more` : ''}
        </div>
      )}
    </div>
  );
}
