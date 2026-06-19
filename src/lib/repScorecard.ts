import type {
  Opportunity, ChangeLogEntry, ManagerQuota, Rep, DealRegistration, Quarter,
} from '@/types/forecast';
import { getCurrentQuarter, getQuarter } from '@/types/forecast';
import { computeCommitAccuracy } from './commitAccuracy';
import { computeSlips } from './slips';
import { computeAeRows } from './aeAccountability';
import { buildChangelogIndex, dealRiskSignals, flagDeal, STALE_DAYS } from './dealRisk';

// Risk flagging now lives in ./dealRisk (shared with the all-reps Deal Risk view).
// Re-exported here so existing consumers of these types keep working unchanged.
export type { RiskFlag, RiskFlagKind, AtRiskDeal } from './dealRisk';
import type { AtRiskDeal } from './dealRisk';

export interface ScorecardContext {
  opportunities: Opportunity[];
  changelog: ChangeLogEntry[];
  dealRegistrations: DealRegistration[];
  managerQuotas: ManagerQuota[];
  reps: Rep[];
}

export interface RepScorecard {
  repId: string;
  repName: string;
  attainment: { quota: number; closedWon: number; gap: number; coverage: number };
  forecast: { commit: number; bestCase: number; commitAccuracy: number | null };
  pipeline: { openCount: number; openAmount: number; stale: number; slipped: number };
  atRisk: AtRiskDeal[];
  channel: { sqlRate: number; rejection: number; unworked: number; padding: number };
  talkingPoints: string[];
}

const TERMINAL = new Set(['closed_won', 'lost', 'omitted', 'rejected']);
const fmtMoney = (n: number) => `$${Math.round(n || 0).toLocaleString('en-US')}`;

export interface ScorecardOpts {
  today?: Date;
  currentQuarter?: Quarter;
}

/**
 * Build a read-only scorecard for one rep, reconciling with Slips, Commit
 * Accuracy and AE Accountability by reusing their lib cores. Pure given ctx+opts.
 */
export function buildRepScorecard(repId: string, ctx: ScorecardContext, opts: ScorecardOpts = {}): RepScorecard {
  // managerQuotas stays on the context for contract stability but is no longer the
  // quota source — attainment is per-rep / per-quarter (rep.quarterlyGoals).
  const { opportunities, changelog, dealRegistrations, reps } = ctx;
  const today = opts.today ?? new Date();
  const currentQuarter = opts.currentQuarter ?? getCurrentQuarter();

  const rep = reps.find(r => r.id === repId);
  const repName = rep?.name ?? '';

  // repId is frequently empty on imported opps, so match by name with an id fallback.
  const repOpps = opportunities.filter(o => (!!repName && o.repName === repName) || (!!o.repId && o.repId === repId));
  const openOpps = repOpps.filter(o => !TERMINAL.has(o.classification));

  const openAmount = openOpps.reduce((s, o) => s + (o.amount || 0), 0);
  const openCount = openOpps.length;

  // ---- attainment: per-rep and per-quarter — the rep's own quarterly goal vs won THIS quarter ----
  const inQuarter = (o: Opportunity) => !!o.closeDate && getQuarter(o.closeDate) === currentQuarter;
  const closedWon = repOpps
    .filter(o => o.classification === 'closed_won' && inQuarter(o))
    .reduce((s, o) => s + (o.amount || 0), 0);
  const quota = rep?.quarterlyGoals[currentQuarter] ?? 0;
  const gap = Math.max(quota - closedWon, 0);
  // coverage = in-quarter open pipeline against the remaining gap
  const openInQuarter = openOpps.filter(inQuarter).reduce((s, o) => s + (o.amount || 0), 0);
  const coverage = openInQuarter / Math.max(gap, 1);

  // ---- forecast ----
  const commit = repOpps.filter(o => o.classification === 'commit').reduce((s, o) => s + (o.amount || 0), 0);
  const upside = repOpps.filter(o => o.classification === 'upside').reduce((s, o) => s + (o.amount || 0), 0);
  const bestCase = commit + upside;
  const ca = computeCommitAccuracy(opportunities, changelog, currentQuarter);
  const caRows = ca.rows.filter(r => r.repName === repName && !r.inProgress);
  const caCommitted = caRows.reduce((s, r) => s + r.committedAmount, 0);
  const caClosed = caRows.reduce((s, r) => s + r.closedFromCommitAmount, 0);
  const commitAccuracy = caCommitted > 0 ? caClosed / caCommitted : null;

  // ---- changelog index + risk flagging (shared with the all-reps Deal Risk view) ----
  const index = buildChangelogIndex(changelog);

  // ---- pipeline ----
  const stale = openOpps.filter(o => dealRiskSignals(o, index, today).daysSinceMovement >= STALE_DAYS).length;
  const slipped = computeSlips(opportunities, changelog, currentQuarter).filter(s => s.repName === repName).length;

  // ---- at-risk deals (flags computed NOW; nextStep/single-threaded left for later) ----
  const atRisk: AtRiskDeal[] = [];
  for (const o of openOpps) {
    const flags = flagDeal(o, index, today);
    if (flags.length) {
      atRisk.push({ id: o.id, name: o.name, amount: o.amount || 0, stage: o.stage, flags, nextStep: o.nextStep?.trim() || null });
    }
  }
  atRisk.sort((a, b) => b.amount - a.amount);

  // ---- channel (reuse AE accountability core over this rep's DRs) ----
  const repDrs = dealRegistrations.filter(d => d.repName === repName);
  const aeRow = computeAeRows(repDrs, { today })[0];
  const channel = {
    sqlRate: aeRow?.sqlRate ?? 0,
    rejection: aeRow && aeRow.assigned ? aeRow.rejected / aeRow.assigned : 0,
    unworked: aeRow?.unworkedPct ?? 0,
    // padding isn't on AeRow; count padded-status DRs for this rep.
    padding: repDrs.filter(d => d.status === 'padded').length,
  };

  // ---- talking points (v1: rule-based, derived from the flags above) ----
  // TODO: replace rule-based talking points with the briefing engine in a later step.
  const talkingPoints: string[] = [];
  for (const o of openOpps) {
    if (o.classification !== 'commit') continue;
    const pc = dealRiskSignals(o, index, today).pushCount;
    if (pc >= 3) {
      talkingPoints.push(`${o.name}: committed but close date pushed ${pc}× (${fmtMoney(o.amount)}). Confirm it is still landing this quarter.`);
    }
  }
  if (commitAccuracy !== null && commitAccuracy < 0.5) {
    talkingPoints.push(`Commit accuracy is ${Math.round(commitAccuracy * 100)}% across resolved quarters — revisit what qualifies as commit.`);
  }
  if (gap > 0 && coverage < 3) {
    talkingPoints.push(`Coverage is ${coverage.toFixed(1)}× against a ${fmtMoney(gap)} gap — pipeline is thin for the target.`);
  }
  if (channel.sqlRate > 0 && channel.sqlRate < 0.2) {
    talkingPoints.push(`Channel SQL rate is ${Math.round(channel.sqlRate * 100)}% — registrations are not reaching qualification.`);
  }

  return {
    repId,
    repName,
    attainment: { quota, closedWon, gap, coverage },
    forecast: { commit, bestCase, commitAccuracy },
    pipeline: { openCount, openAmount, stale, slipped },
    atRisk,
    channel,
    talkingPoints,
  };
}
