import type { DealRegistration } from '@/types/forecast';

// ============================================================
// Anchor analysis — distinguish the real worked deal from padding satellites
// on multi-registration accounts (same accountName + CAM).
// ============================================================

export type AnchorRole = 'anchor' | 'satellite' | 'single' | 'orphan_cluster';
// anchor          = the worked deal on a multi-reg account (exempt from cleanup)
// satellite       = padding on a multi-reg account (cleanup target)
// single          = only registration on its account (normal cadence)
// orphan_cluster  = multi-reg account with NO activity anywhere (immediate AE action)

export interface AnchorAnalysis {
  accountKey: string;          // accountName::cam
  accountName: string;
  cam: string;
  totalRegs: number;
  anchorId: string | null;
  satelliteIds: string[];
  hasNoActivityAnywhere: boolean;
}

const TERMINAL: ReadonlySet<string> = new Set(['rejected', 'withdrawn', 'closed_won', 'closed_lost']);

function accountKey(dr: DealRegistration): string {
  return `${(dr.accountName || '').toLowerCase().trim()}::${dr.channelAccountManager || ''}`;
}

export function analyzeAnchors(drs: DealRegistration[]): Map<string, AnchorAnalysis> {
  const groups = new Map<string, DealRegistration[]>();

  for (const dr of drs) {
    if (TERMINAL.has(dr.status)) continue;
    const key = accountKey(dr);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(dr);
  }

  const result = new Map<string, AnchorAnalysis>();

  for (const [key, groupDrs] of groups.entries()) {
    if (groupDrs.length < 2) continue;

    const withActivity = groupDrs.filter(d => d.lastActivity && d.lastActivity.trim());

    let anchorId: string | null = null;
    let hasNoActivityAnywhere = false;

    if (withActivity.length > 0) {
      // Anchor = the DR with the OLDEST lastActivity (first engaged)
      withActivity.sort(
        (a, b) => new Date(a.lastActivity!).getTime() - new Date(b.lastActivity!).getTime()
      );
      anchorId = withActivity[0].opportunityId;
    } else {
      hasNoActivityAnywhere = true;
    }

    const satelliteIds = groupDrs
      .filter(d => d.opportunityId !== anchorId)
      .map(d => d.opportunityId);

    result.set(key, {
      accountKey: key,
      accountName: groupDrs[0].accountName || '',
      cam: groupDrs[0].channelAccountManager || '',
      totalRegs: groupDrs.length,
      anchorId,
      satelliteIds,
      hasNoActivityAnywhere,
    });
  }

  return result;
}

// ============================================================
// Cadence-based cleanup stages (15 / 15 / final notice)
// ============================================================

export type CleanupStage =
  | 'monitoring'        // < 15 days
  | 'partner_outreach'  // 15-29 days
  | 'final_notice'      // 30-44 days
  | 'ready_to_close'    // 45+ days
  | 'exempt';           // anchor

export interface CleanupClassification {
  dr: DealRegistration;
  anchorRole: AnchorRole;
  cleanupStage: CleanupStage;
  daysSinceActivity: number;
  immediateAction: boolean;
  recommendedAction: string;
  /** Total registrations on this account+CAM (for orphan/satellite context). */
  accountRegCount: number;
}

export function classifyCleanup(
  drs: DealRegistration[],
  today: Date = new Date()
): CleanupClassification[] {
  const anchorMap = analyzeAnchors(drs);

  const roleById = new Map<string, AnchorRole>();
  for (const analysis of anchorMap.values()) {
    if (analysis.hasNoActivityAnywhere) {
      for (const id of [analysis.anchorId, ...analysis.satelliteIds].filter(Boolean) as string[]) {
        roleById.set(id, 'orphan_cluster');
      }
    } else {
      if (analysis.anchorId) roleById.set(analysis.anchorId, 'anchor');
      for (const id of analysis.satelliteIds) roleById.set(id, 'satellite');
    }
  }

  const results: CleanupClassification[] = [];

  for (const dr of drs) {
    if (TERMINAL.has(dr.status)) continue;

    const role = roleById.get(dr.opportunityId) || 'single';
    const analysis = anchorMap.get(accountKey(dr));
    const accountRegCount = analysis?.totalRegs ?? 1;

    const refDateStr = dr.lastActivity?.trim() ? dr.lastActivity : dr.createdDate;
    const refDate = refDateStr ? new Date(refDateStr) : today;
    const daysSinceActivity = Math.floor((today.getTime() - refDate.getTime()) / 86400000);

    if (role === 'anchor') {
      results.push({
        dr,
        anchorRole: role,
        cleanupStage: 'exempt',
        daysSinceActivity,
        immediateAction: false,
        accountRegCount,
        recommendedAction: 'Anchor opportunity — actively worked. No action needed.',
      });
      continue;
    }

    if (role === 'orphan_cluster') {
      results.push({
        dr,
        anchorRole: role,
        cleanupStage: 'partner_outreach',
        daysSinceActivity,
        immediateAction: true,
        accountRegCount,
        recommendedAction: `Account has ${accountRegCount} registrations with NO activity on any. AE must engage or close all.`,
      });
      continue;
    }

    let stage: CleanupStage;
    let action: string;
    if (daysSinceActivity < 15) {
      stage = 'monitoring';
      action = 'Within initial 15-day follow-up window. AE to continue outreach.';
    } else if (daysSinceActivity < 30) {
      stage = 'partner_outreach';
      action = 'Send partner rep email (CC CAM): 15-day response window before closure.';
    } else if (daysSinceActivity < 45) {
      stage = 'final_notice';
      action = 'Send final notice email: registration will be closed if no response.';
    } else {
      stage = 'ready_to_close';
      action = 'No response after 30+ days. Close the deal registration.';
    }

    results.push({
      dr,
      anchorRole: role,
      cleanupStage: stage,
      daysSinceActivity,
      immediateAction: false,
      accountRegCount,
      recommendedAction: action,
    });
  }

  const stageOrder: CleanupStage[] = ['partner_outreach', 'ready_to_close', 'final_notice', 'monitoring', 'exempt'];
  return results.sort((a, b) => {
    if (a.immediateAction !== b.immediateAction) return a.immediateAction ? -1 : 1;
    // Ready to close ranks above other non-immediate stages
    const priority = (c: CleanupClassification): number => {
      if (c.immediateAction) return 0;
      if (c.cleanupStage === 'ready_to_close') return 1;
      if (c.cleanupStage === 'final_notice') return 2;
      if (c.cleanupStage === 'partner_outreach') return 3;
      if (c.cleanupStage === 'monitoring') return 4;
      return 5;
    };
    const pa = priority(a);
    const pb = priority(b);
    if (pa !== pb) return pa - pb;
    return b.daysSinceActivity - a.daysSinceActivity;
  });
}

// ============================================================
// Email / grouping helpers
// ============================================================

// Convert "First Last" -> "first.last@n-able.com"
export function nameToEmail(name: string): string {
  if (!name || !name.trim()) return '';
  const parts = name.trim().toLowerCase().split(/\s+/);
  if (parts.length < 2) return `${parts[0]}@n-able.com`;
  return `${parts[0]}.${parts[parts.length - 1]}@n-able.com`;
}

export interface CamCleanupGroup {
  cam: string;
  camEmail: string;
  /** Actionable items only — anchors are excluded. */
  deals: CleanupClassification[];
  aeEmails: string[];
  stageCounts: Record<CleanupStage, number>;
  immediateCount: number;
}

export function groupByCAM(items: CleanupClassification[]): CamCleanupGroup[] {
  const groups = new Map<string, CamCleanupGroup>();
  for (const item of items) {
    if (item.cleanupStage === 'exempt') continue; // anchors never appear in cleanup
    const cam = item.dr.channelAccountManager?.trim() || 'No CAM';
    let g = groups.get(cam);
    if (!g) {
      g = {
        cam,
        camEmail: cam === 'No CAM' ? '' : nameToEmail(cam),
        deals: [],
        aeEmails: [],
        stageCounts: { monitoring: 0, partner_outreach: 0, final_notice: 0, ready_to_close: 0, exempt: 0 },
        immediateCount: 0,
      };
      groups.set(cam, g);
    }
    g.deals.push(item);
    g.stageCounts[item.cleanupStage]++;
    if (item.immediateAction) g.immediateCount++;
    const aeEmail = nameToEmail(item.dr.repName || '');
    if (aeEmail && !g.aeEmails.includes(aeEmail)) g.aeEmails.push(aeEmail);
  }
  return Array.from(groups.values()).sort((a, b) => b.deals.length - a.deals.length);
}

export function buildCleanupEmailPrompt(group: CamCleanupGroup): string {
  const closing = group.deals.filter(d => d.cleanupStage === 'ready_to_close' || d.immediateAction);
  const finalNotice = group.deals.filter(d => d.cleanupStage === 'final_notice' && !d.immediateAction);
  const outreach = group.deals.filter(d => d.cleanupStage === 'partner_outreach' && !d.immediateAction);

  const fmt = (d: CleanupClassification) =>
    `- ${d.dr.opportunityName} (${d.dr.accountName}) — ${d.dr.stage}, ${d.daysSinceActivity}d since activity, AE: ${d.dr.repName}${
      d.anchorRole === 'satellite' ? ` [satellite of multi-reg account, ${d.accountRegCount} regs total]` : ''
    }${d.anchorRole === 'orphan_cluster' ? ` [orphan cluster, ${d.accountRegCount} regs no activity]` : ''}`;

  const aeNames = group.aeEmails
    .map(e => e.split('@')[0].split('.').map(n => n.charAt(0).toUpperCase() + n.slice(1)).join(' '))
    .join(', ');

  return `Write a professional email from a sales manager to a channel partner CAM about deal registrations in our cleanup cadence.

CAM Name: ${group.cam}
AEs CC'd: ${aeNames}

${closing.length > 0 ? `CLOSING NOW (45+ days no activity, or multi-reg accounts with no activity anywhere):
These registrations are being closed per our deal registration policy. No response needed.
${closing.map(fmt).join('\n')}` : ''}

${finalNotice.length > 0 ? `FINAL NOTICE (30-44 days no activity):
These need confirmation within 15 days or they will be closed.
${finalNotice.map(fmt).join('\n')}` : ''}

${outreach.length > 0 ? `PARTNER OUTREACH (15-29 days no activity):
These have been quiet for 15+ days — please confirm status with your rep.
${outreach.map(fmt).join('\n')}` : ''}

Write the email with these requirements:
- Professional but direct tone — this is a business conversation, not a complaint
- From "Michael Wells, Sales Manager" at N-able
- Subject line included at the top as "Subject: [subject line here]"
- Reference the agreed deal registration policy explicitly (15-day partner outreach window, 15-day final notice, then closure)
- For accounts with multiple registrations, mention that we are RETAINING the primary opportunity being actively worked (the anchor) and only addressing the satellite registrations that have had no independent activity. This shows we're being surgical, not blunt.
- For CLOSING NOW items: state clearly they are being closed — no response needed
- For FINAL NOTICE items: ask for confirmation within 15 days, otherwise will close
- For PARTNER OUTREACH items: ask the partner rep to confirm status
- Close by offering to discuss on a call if needed
- Sign off as Michael Wells
- Plain text only, no markdown, no bullet symbols — use dashes if needed
- Keep it under 350 words`;
}

// ============================================================
// Briefing summary
// ============================================================

export interface CleanupSummary {
  totalActionable: number;
  immediateAction: number;
  readyToClose: number;
  finalNotice: number;
  partnerOutreach: number;
  monitoring: number;
  anchorsExempt: number;
  topOrphanAccounts: { account: string; cam: string; regCount: number }[];
  orphansByRep: { rep: string; account: string; cam: string; regCount: number }[];
  byRep: { rep: string; immediate: number; readyToClose: number; finalNotice: number; partnerOutreach: number; total: number }[];
}

export function buildCleanupSummary(items: CleanupClassification[]): CleanupSummary {
  const actionable = items.filter(i => i.cleanupStage !== 'exempt');
  const anchorsExempt = items.filter(i => i.cleanupStage === 'exempt').length;

  const repMap = new Map<string, { immediate: number; readyToClose: number; finalNotice: number; partnerOutreach: number; total: number }>();
  for (const item of actionable) {
    const rep = item.dr.repName?.trim() || '(unassigned)';
    const cur = repMap.get(rep) || { immediate: 0, readyToClose: 0, finalNotice: 0, partnerOutreach: 0, total: 0 };
    if (item.immediateAction) cur.immediate++;
    else if (item.cleanupStage === 'ready_to_close') cur.readyToClose++;
    else if (item.cleanupStage === 'final_notice') cur.finalNotice++;
    else if (item.cleanupStage === 'partner_outreach') cur.partnerOutreach++;
    cur.total++;
    repMap.set(rep, cur);
  }

  // Dedupe orphan clusters by account+cam
  const orphanSeen = new Map<string, { account: string; cam: string; regCount: number; rep: string }>();
  for (const item of items) {
    if (item.anchorRole !== 'orphan_cluster') continue;
    const key = `${(item.dr.accountName || '').toLowerCase()}::${item.dr.channelAccountManager || ''}`;
    if (!orphanSeen.has(key)) {
      orphanSeen.set(key, {
        account: item.dr.accountName || '',
        cam: item.dr.channelAccountManager || '',
        regCount: item.accountRegCount,
        rep: item.dr.repName || '',
      });
    }
  }
  const orphanList = Array.from(orphanSeen.values()).sort((a, b) => b.regCount - a.regCount);

  return {
    totalActionable: actionable.length,
    immediateAction: actionable.filter(i => i.immediateAction).length,
    readyToClose: actionable.filter(i => i.cleanupStage === 'ready_to_close').length,
    finalNotice: actionable.filter(i => i.cleanupStage === 'final_notice').length,
    partnerOutreach: actionable.filter(i => i.cleanupStage === 'partner_outreach' && !i.immediateAction).length,
    monitoring: actionable.filter(i => i.cleanupStage === 'monitoring').length,
    anchorsExempt,
    topOrphanAccounts: orphanList.slice(0, 5).map(o => ({ account: o.account, cam: o.cam, regCount: o.regCount })),
    orphansByRep: orphanList.map(o => ({ rep: o.rep, account: o.account, cam: o.cam, regCount: o.regCount })),
    byRep: Array.from(repMap.entries())
      .map(([rep, v]) => ({ rep, ...v }))
      .sort((a, b) => b.total - a.total),
  };
}
