import type { DealRegistration } from '@/types/forecast';

export type CleanupTier = 1 | 2 | 3;

export interface CleanupDeal {
  dr: DealRegistration;
  tier: CleanupTier;
  tierLabel: string;
  reason: string;
  actionRequired: string;
  deadlineDays: number;
}

export interface CamCleanupGroup {
  cam: string;
  camEmail: string;
  deals: CleanupDeal[];
  tier1Count: number;
  tier2Count: number;
  tier3Count: number;
  aeEmails: string[];
}

// Convert "First Last" -> "first.last@n-able.com"
// Hyphenated last names preserved: "Wayne Bowe-McLeod" -> "wayne.bowe-mcleod@n-able.com"
export function nameToEmail(name: string): string {
  if (!name || !name.trim()) return '';
  const parts = name.trim().toLowerCase().split(/\s+/);
  if (parts.length < 2) return `${parts[0]}@n-able.com`;
  return `${parts[0]}.${parts[parts.length - 1]}@n-able.com`;
}

const TIER3_STAGES = ['Discovery 25%', 'Technical 50%', 'Commercial 75%', 'Purchasing 90%'];
const TERMINAL: ReadonlySet<string> = new Set(['rejected', 'withdrawn', 'closed_won', 'closed_lost']);

export function classifyCleanupDeals(drs: DealRegistration[]): CleanupDeal[] {
  const results: CleanupDeal[] = [];

  // Padding detection: 3+ pre-SQL, no-activity registrations on the same account+CAM
  const accountCamMap = new Map<string, number>();
  for (const dr of drs) {
    if (TERMINAL.has(dr.status)) continue;
    if (dr.isSql) continue;
    if (dr.lastActivity) continue;
    const key = `${(dr.accountName || '').toLowerCase()}::${dr.channelAccountManager || ''}`;
    accountCamMap.set(key, (accountCamMap.get(key) || 0) + 1);
  }

  for (const dr of drs) {
    if (TERMINAL.has(dr.status)) continue;

    const stage = (dr.stage || '').trim();
    const ageDays = dr.ageDays || 0;
    const hasActivity = !!dr.lastActivity;

    const paddingKey = `${(dr.accountName || '').toLowerCase()}::${dr.channelAccountManager || ''}`;
    const paddingCount = accountCamMap.get(paddingKey) || 0;
    const isPadded = paddingCount >= 3 && !dr.isSql && !hasActivity && ageDays >= 30;

    // Tier 1
    if ((stage === 'Unqualified' && !hasActivity && ageDays > 90) || isPadded) {
      results.push({
        dr,
        tier: 1,
        tierLabel: 'Immediate Action',
        reason: isPadded
          ? `Account has ${paddingCount} unworked registrations from this partner`
          : `Unqualified for ${ageDays} days with no activity`,
        actionRequired: 'AE to close in Salesforce. No CAM response needed.',
        deadlineDays: 5,
      });
      continue;
    }

    // Tier 2
    if (stage === 'Qualified 5%' && !hasActivity && ageDays > 60) {
      results.push({
        dr,
        tier: 2,
        tierLabel: 'CAM Response Required',
        reason: `Qualified ${ageDays} days ago with no activity logged`,
        actionRequired: 'CAM to confirm deal is still active or AE will withdraw.',
        deadlineDays: 5,
      });
      continue;
    }

    // Tier 3
    if (TIER3_STAGES.includes(stage) && !hasActivity && ageDays > 30) {
      results.push({
        dr,
        tier: 3,
        tierLabel: 'AE Action Required',
        reason: `At ${stage} for ${ageDays} days with no activity`,
        actionRequired: 'AE to advance to next stage or withdraw within 30 days.',
        deadlineDays: 10,
      });
    }
  }

  results.sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : b.dr.ageDays - a.dr.ageDays));
  return results;
}

export function groupByCAM(deals: CleanupDeal[]): CamCleanupGroup[] {
  const groups = new Map<string, CamCleanupGroup>();
  for (const deal of deals) {
    const cam = deal.dr.channelAccountManager?.trim() || 'No CAM';
    let g = groups.get(cam);
    if (!g) {
      g = {
        cam,
        camEmail: cam === 'No CAM' ? '' : nameToEmail(cam),
        deals: [],
        tier1Count: 0,
        tier2Count: 0,
        tier3Count: 0,
        aeEmails: [],
      };
      groups.set(cam, g);
    }
    g.deals.push(deal);
    if (deal.tier === 1) g.tier1Count++;
    else if (deal.tier === 2) g.tier2Count++;
    else g.tier3Count++;
    const aeEmail = nameToEmail(deal.dr.repName || '');
    if (aeEmail && !g.aeEmails.includes(aeEmail)) g.aeEmails.push(aeEmail);
  }
  return Array.from(groups.values()).sort((a, b) => b.deals.length - a.deals.length);
}

export function buildCleanupEmailPrompt(group: CamCleanupGroup): string {
  const today = new Date();
  const deadline = new Date(today.getTime() + 5 * 86400000);
  const deadlineStr = deadline.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const tier1 = group.deals.filter(d => d.tier === 1);
  const tier2 = group.deals.filter(d => d.tier === 2);
  const tier3 = group.deals.filter(d => d.tier === 3);

  const dealList = (deals: CleanupDeal[]) =>
    deals.map(d => `- ${d.dr.opportunityName} (${d.dr.accountName}) — ${d.dr.stage}, ${d.dr.ageDays} days, AE: ${d.dr.repName}`).join('\n');

  const aeNames = group.aeEmails
    .map(e => e.split('@')[0].split('.').map(n => n.charAt(0).toUpperCase() + n.slice(1)).join(' '))
    .join(', ');

  return `Write a professional email from a sales manager to a channel partner CAM about stale deal registrations that need attention.

CAM Name: ${group.cam}
Deadline for response: ${deadlineStr}
AEs CC'd: ${aeNames}

${tier1.length > 0 ? `TIER 1 — Immediate action (90+ days, no activity or padded accounts):
These will be withdrawn by the deadline regardless of response.
${dealList(tier1)}` : ''}

${tier2.length > 0 ? `TIER 2 — CAM response required (60+ days at Qualified 5%, no activity):
Please confirm these are still active opportunities by the deadline or they will be withdrawn.
${dealList(tier2)}` : ''}

${tier3.length > 0 ? `TIER 3 — AE action items (30+ days at Discovery or above, no activity):
Our AEs are aware and will be advancing or withdrawing these within 30 days.
These are listed for your awareness.
${dealList(tier3)}` : ''}

Write the email with these requirements:
- Professional but direct tone — this is a business conversation, not a complaint
- From "Michael Wells, Sales Manager" at N-able
- Subject line included at the top as "Subject: [subject line here]"
- Open by acknowledging the partnership and the purpose of the review
- For Tier 1 deals: state clearly they will be withdrawn by ${deadlineStr} — no response needed, just informing
- For Tier 2 deals: ask for confirmation of deal status by ${deadlineStr}, otherwise will withdraw
- For Tier 3 deals: mention briefly that AEs are following up — no action needed from CAM
- Close by offering to discuss on a call if needed
- Sign off as Michael Wells
- Plain text only, no markdown, no bullet symbols — use dashes if needed
- Keep it under 300 words`;
}

export interface CleanupSummary {
  totalDeals: number;
  tier1Count: number;
  tier2Count: number;
  tier3Count: number;
  topCams: { cam: string; count: number; tier1: number }[];
  byRep: { rep: string; tier1: number; tier2: number; tier3: number; total: number }[];
}

export function buildCleanupSummary(deals: CleanupDeal[]): CleanupSummary {
  const groups = groupByCAM(deals);
  const repMap = new Map<string, { tier1: number; tier2: number; tier3: number; total: number }>();
  for (const d of deals) {
    const rep = d.dr.repName?.trim() || '(unassigned)';
    const cur = repMap.get(rep) || { tier1: 0, tier2: 0, tier3: 0, total: 0 };
    if (d.tier === 1) cur.tier1++;
    else if (d.tier === 2) cur.tier2++;
    else cur.tier3++;
    cur.total++;
    repMap.set(rep, cur);
  }
  return {
    totalDeals: deals.length,
    tier1Count: deals.filter(d => d.tier === 1).length,
    tier2Count: deals.filter(d => d.tier === 2).length,
    tier3Count: deals.filter(d => d.tier === 3).length,
    topCams: groups.slice(0, 5).map(g => ({ cam: g.cam, count: g.deals.length, tier1: g.tier1Count })),
    byRep: Array.from(repMap.entries())
      .map(([rep, v]) => ({ rep, ...v }))
      .sort((a, b) => b.total - a.total),
  };
}
