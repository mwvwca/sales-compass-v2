import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Mail, Copy, RefreshCw, ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import type { DealRegistration } from '@/types/forecast';
import {
  classifyCleanupDeals,
  groupByCAM,
  buildCleanupEmailPrompt,
  type CamCleanupGroup,
  type CleanupTier,
} from '@/lib/drCleanup';
import { callBriefingApi } from '@/lib/briefingApi';

const EMAIL_SYSTEM_PROMPT =
  'You are an assistant that writes concise, professional pipeline cleanup emails on behalf of a sales manager. Always include a Subject line first. Plain text only, no markdown.';

function tierBadgeCls(tier: CleanupTier): string {
  switch (tier) {
    case 1: return 'bg-red-500/15 text-red-700 dark:text-red-400';
    case 2: return 'bg-amber-500/15 text-amber-700 dark:text-amber-400';
    case 3: return 'bg-blue-500/15 text-blue-700 dark:text-blue-400';
  }
}
function tierShort(tier: CleanupTier): string {
  return tier === 1 ? 'Immediate' : tier === 2 ? 'CAM Response' : 'AE Action';
}

function extractSubject(emailText: string): { subject: string; body: string } {
  const m = emailText.match(/^\s*Subject:\s*(.+)\s*\n+/i);
  if (m) {
    return { subject: m[1].trim(), body: emailText.slice(m[0].length).trim() };
  }
  return { subject: 'Pipeline Review — Deal Registration Cleanup', body: emailText.trim() };
}

interface Props {
  dealRegistrations: DealRegistration[];
}

export default function DrCleanupPlanSection({ dealRegistrations }: Props) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(true);
  const [openCam, setOpenCam] = useState<string | null>(null);
  const [emails, setEmails] = useState<Record<string, string>>({});
  const [loadingCam, setLoadingCam] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number } | null>(null);

  const { deals, groups, tierTotals } = useMemo(() => {
    const ds = classifyCleanupDeals(dealRegistrations);
    const gs = groupByCAM(ds);
    return {
      deals: ds,
      groups: gs,
      tierTotals: {
        t1: ds.filter(d => d.tier === 1).length,
        t2: ds.filter(d => d.tier === 2).length,
        t3: ds.filter(d => d.tier === 3).length,
      },
    };
  }, [dealRegistrations]);

  const generateForCam = async (group: CamCleanupGroup): Promise<string | null> => {
    try {
      const prompt = buildCleanupEmailPrompt(group);
      const text = await callBriefingApi(EMAIL_SYSTEM_PROMPT, prompt, { maxTokens: 800 });
      setEmails(prev => ({ ...prev, [group.cam]: text }));
      return text;
    } catch (err: any) {
      toast({
        title: `Email generation failed for ${group.cam}`,
        description: err?.message || 'Use the To/CC/Subject fields below to compose manually.',
        variant: 'destructive',
      });
      return null;
    }
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
            <p className="text-[11px] text-muted-foreground">Stale and padded deal registrations requiring action. Sorted by priority.</p>
          </div>
        </div>
        <span className="text-[11px] text-muted-foreground">{deals.length} flagged · {groups.length} CAMs</span>
      </button>

      {expanded && (
        <div className="p-4 space-y-4">
          {deals.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">
              No cleanup actions required — pipeline is healthy.
            </p>
          ) : (
            <>
              {/* Summary bar */}
              <div className="border border-border rounded-md p-3 flex items-center justify-between gap-3 flex-wrap bg-secondary/20">
                <div className="space-y-1">
                  <p className="text-xs font-medium">
                    ⚠ {deals.length} deals require action across {groups.length} CAM{groups.length === 1 ? '' : 's'}
                  </p>
                  <div className="flex items-center gap-3 text-[11px] flex-wrap">
                    <span className="text-red-700 dark:text-red-400">Tier 1 (Immediate): {tierTotals.t1}</span>
                    <span className="text-amber-700 dark:text-amber-400">Tier 2 (CAM Response): {tierTotals.t2}</span>
                    <span className="text-blue-700 dark:text-blue-400">Tier 3 (AE Action): {tierTotals.t3}</span>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleGenerateAll}
                  disabled={!!bulkProgress || !!loadingCam}
                  className="h-8 text-xs"
                >
                  {bulkProgress ? (
                    <>
                      <Loader2 size={12} className="animate-spin" />
                      Generating {bulkProgress.current} of {bulkProgress.total}…
                    </>
                  ) : (
                    <>
                      <Mail size={12} />
                      Generate All Emails
                    </>
                  )}
                </Button>
              </div>

              {/* Per-CAM accordion */}
              <div className="space-y-2">
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
                              <span className="text-muted-foreground">·</span>
                              <span className="text-red-700 dark:text-red-400">T1: {group.tier1Count}</span>
                              <span className="text-amber-700 dark:text-amber-400">T2: {group.tier2Count}</span>
                              <span className="text-blue-700 dark:text-blue-400">T3: {group.tier3Count}</span>
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
                        <div className="border-t border-border">
                          {/* Deal list */}
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead className="bg-secondary/30 text-muted-foreground">
                                <tr>
                                  <th className="text-left px-3 py-1.5 font-medium">Opportunity</th>
                                  <th className="text-left px-3 py-1.5 font-medium">Account</th>
                                  <th className="text-left px-3 py-1.5 font-medium">AE</th>
                                  <th className="text-left px-3 py-1.5 font-medium">Stage</th>
                                  <th className="text-right px-3 py-1.5 font-medium">Age</th>
                                  <th className="text-left px-3 py-1.5 font-medium">Reason</th>
                                  <th className="text-left px-3 py-1.5 font-medium">Tier</th>
                                </tr>
                              </thead>
                              <tbody>
                                {group.deals.map(d => (
                                  <tr key={d.dr.opportunityId} className="border-t border-border/60">
                                    <td className="px-3 py-1.5">{d.dr.opportunityName}</td>
                                    <td className="px-3 py-1.5">{d.dr.accountName}</td>
                                    <td className="px-3 py-1.5">{d.dr.repName}</td>
                                    <td className="px-3 py-1.5">{d.dr.stage}</td>
                                    <td className="px-3 py-1.5 text-right tabular-nums">{d.dr.ageDays}d</td>
                                    <td className="px-3 py-1.5 text-muted-foreground">{d.reason}</td>
                                    <td className="px-3 py-1.5">
                                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${tierBadgeCls(d.tier)}`}>
                                        T{d.tier} {tierShort(d.tier)}
                                      </span>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>

                          {/* Email panel (always show To/CC/Subject so user can compose manually if API fails) */}
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
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
