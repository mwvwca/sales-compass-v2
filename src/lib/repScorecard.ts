import type {
  Opportunity, ChangeLogEntry, ManagerQuota, Rep, DealRegistration, Quarter,
} from '@/types/forecast';
import { getCurrentQuarter, getQuarter } from '@/types/forecast';
import { currentlySql } from './drSql';
import { computeCommitAccuracy } from './commitAccuracy';
import { computeSlips } from './slips';
import { computeAeRows } from './aeAccountability';

// ---- Tunables ----
const STALE_DAYS = 30;      // open deal with no changelog movement in this many days
const PUSH_FLAG_MIN = 2;    // close-date pushes before a deal is flagged "pushed"

export interface ScorecardContext {
  opportunities: Opportunity[];
  changelog: ChangeLogEntry[];
  dealRegistrations: DealRegistration[];
  managerQuotas: ManagerQuota[];
  reps: Rep[];
}

/**
 * Risk flag kinds. `no_next_step` and `single_threaded` are defined now but NOT
 * populated — that data arrives in a later roadmap step. We never fabricate them.
 */
export type RiskFlagKind =
  | 'pushed'
  | 'stalled'
  | 'under_qualified'
  | 'no_next_step'
  | 'single_threaded';

export interface RiskFlag {
  kind: RiskFlagKind;
  detail?: string;
}

export interface AtRiskDeal {
  id: string;
  name: string;
  amount: number;
  stage: string;
  flags: RiskFlag[];
  /** Stage 2 (notes capture) — defined but unpopulated for now. */
  nextStep: string | null;
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

  // ---- changelog-derived per-opp signals ----
  const byOpp = new Map<string, ChangeLogEntry[]>();
  for (const e of changelog) {
    const arr = byOpp.get(e.opportunityId);
    if (arr) arr.push(e); else byOpp.set(e.opportunityId, [e]);
  }
  const lastMovement = (o: Opportunity): string | undefined => {
    const dates = (byOpp.get(o.id) ?? []).map(e => e.importDate).filter(Boolean);
    return dates.length ? dates.sort()[dates.length - 1] : o.importDate;
  };
  const daysSinceMovement = (o: Opportunity): number => {
    const last = lastMovement(o);
    const d = last ? new Date(last) : null;
    if (!d || isNaN(d.getTime())) return 0;
    return Math.max(0, Math.floor((today.getTime() - d.getTime()) / 86_400_000));
  };
  const pushCount = (o: Opportunity): number =>
    (byOpp.get(o.id) ?? []).filter(e => e.field === 'closeDate' && e.oldValue && e.newValue).length;

  // ---- pipeline ----
  const stale = openOpps.filter(o => daysSinceMovement(o) >= STALE_DAYS).length;
  const slipped = computeSlips(opportunities, changelog, currentQuarter).filter(s => s.repName === repName).length;

  // ---- at-risk deals (flags computed NOW; nextStep/single-threaded left for later) ----
  const atRisk: AtRiskDeal[] = [];
  for (const o of openOpps) {
    const flags: RiskFlag[] = [];
    const pc = pushCount(o);
    if (pc >= PUSH_FLAG_MIN) flags.push({ kind: 'pushed', detail: `close date pushed ${pc}×` });
    const dsm = daysSinceMovement(o);
    if (dsm >= STALE_DAYS) flags.push({ kind: 'stalled', detail: `${dsm}d no movement` });
    if (!currentlySql({ probability: o.probability })) {
      flags.push({ kind: 'under_qualified', detail: `${Math.round((o.probability ?? 0) * 100)}% probability` });
    }
    // 'no_next_step' / 'single_threaded' arrive with notes capture (Stage 2) — not populated yet.
    if (flags.length) {
      atRisk.push({ id: o.id, name: o.name, amount: o.amount || 0, stage: o.stage, flags, nextStep: null });
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
    if (o.classification === 'commit' && pushCount(o) >= 3) {
      talkingPoints.push(`${o.name}: committed but close date pushed ${pushCount(o)}× (${fmtMoney(o.amount)}). Confirm it is still landing this quarter.`);
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
