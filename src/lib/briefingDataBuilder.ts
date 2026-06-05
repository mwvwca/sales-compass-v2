import type {
  Opportunity,
  Rep,
  ChangeLogEntry,
  ImportRecord,
  DealRegistration,
  MonthlyManagerCommit,
  ManagerQuota,
} from '@/types/forecast';
import {
  getMonthKey,
  getCurrentQuarter,
  getWeeksInMonth,
  getDateAtUtcStart,
} from '@/types/forecast';
import type { BriefingMode } from './briefingPrompts';

export interface BriefingPayload {
  mode: BriefingMode;
  generatedAt: string;
  lastImportDate: string;
  lastImportFile: string;
  currentMonth: string;
  currentQuarter: string;
  daysLeftInMonth: number;
  teamQuota: number;
  managerCommit: number;
  closedWonMTD: number;
  totalOpenPipeline: number;
  commitPipeline: number;
  upsidePipeline: number;
  pipelineCoverage: number;
  newDeals: { name: string; rep: string; amount: number; closeDate: string; classification: string }[];
  lostDeals: { name: string; rep: string; amount: number }[];
  pushedDeals: { name: string; rep: string; amount: number; oldClose: string; newClose: string }[];
  classificationChanges: { name: string; rep: string; amount: number; from: string; to: string }[];
  amountChanges: { name: string; rep: string; oldAmount: number; newAmount: number }[];
  repSummaries: {
    repName: string;
    openPipeline: number;
    commitPipeline: number;
    closedWonMTD: number;
    staleDealCount: number;
    commitDeals: { name: string; amount: number; closeDate: string; weekLabel: string }[];
    futureCommits: { name: string; amount: number; closeDate: string }[];
    futureCommitTotal: number;
    upsideDeals?: { name: string; amount: number; closeDate: string }[];
    changesSinceLastImport: { name: string; type: string; detail: string }[];
  }[];
  drSignals: {
    totalOpenDrs: number;
    staleDrCount: number;
    rejectedCount: number;
    topCams: { cam: string; openCount: number }[];
    topResellers: { name: string; totalDrs: number; cohortRate: number; closedWon: number }[];
    lowResellers: { name: string; totalDrs: number; cohortRate: number }[];
    dataFloor: string;
    dataNote: string;
    dealQualityAnalysis: {
      totalDrs: number;
      sqlRate: number;
      winRateOnSQL: number;
      overallCohortRate: number;
      qualityGapPp: number;
      insightStatement: string;
      primaryProblem: 'lead_quality' | 'execution' | 'both' | 'performing';
    };
  } | null;
  closingThisWeek: { name: string; rep: string; amount: number; closeDate: string; classification: string }[];
  closingNextWeek: { name: string; rep: string; amount: number; closeDate: string; classification: string }[];
  pastDueCommits: { name: string; rep: string; amount: number; closeDate: string }[];
}

interface BuilderInput {
  mode: BriefingMode;
  opportunities: Opportunity[];
  reps: Rep[];
  imports: ImportRecord[];
  changelog: ChangeLogEntry[];
  dealRegistrations: DealRegistration[];
  monthlyManagerCommits: MonthlyManagerCommit[];
  managerQuotas: ManagerQuota[];
}

const TOP_N = 10;

function topByAmount<T extends { amount: number }>(arr: T[], n = TOP_N): T[] {
  return [...arr].sort((a, b) => b.amount - a.amount).slice(0, n);
}

function daysLeftInMonth(now: Date): number {
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return Math.max(0, Math.ceil((last.getTime() - now.getTime()) / 86400000));
}

function isOpen(o: Opportunity): boolean {
  return o.classification !== 'closed_won' &&
    o.classification !== 'lost' &&
    o.classification !== 'omitted' &&
    o.classification !== 'rejected';
}

function isCommit(o: Opportunity): boolean {
  return o.classification === 'commit' ||
    o.forecastCategory?.toLowerCase().trim() === 'commit';
}

function inMonth(dateStr: string, monthKey: string): boolean {
  try { return getMonthKey(dateStr) === monthKey; } catch { return false; }
}

function parseDateLocal(dateStr: string): Date | null {
  if (!dateStr) return null;
  const iso = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
  const us = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return new Date(+us[3], +us[1] - 1, +us[2]);
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}
function getWeekLabel(dateStr: string, monthKey: string): string {
  const weeks = getWeeksInMonth(monthKey);
  const d = getDateAtUtcStart(dateStr);
  for (const w of weeks) {
    if (d >= w.start && d <= w.end) return w.label;
  }
  return '';
}

export function buildBriefingPayload(input: BuilderInput): BriefingPayload {
  const now = new Date();
  const monthKey = getMonthKey(now.toISOString());
  const quarter = getCurrentQuarter();
  const monthLabel = now.toLocaleString('default', { month: 'long', year: 'numeric' });

  const lastImport = [...input.imports].sort((a, b) => b.date.localeCompare(a.date))[0];
  const lastImportDate = lastImport?.date || '';
  const lastImportFile = lastImport?.fileName || '';

  const activeReps = input.reps.filter(r => r.isActive !== false);
  

  const opps = input.opportunities;
  const openOpps = opps.filter(isOpen);
  const commitOpps = opps.filter(isCommit);
  const upsideOpps = opps.filter(o => o.classification === 'upside');
  const closedWonMtdOpps = opps.filter(o => o.classification === 'closed_won' && inMonth(o.closeDate, monthKey));

  const totalOpenPipeline = openOpps.reduce((s, o) => s + o.amount, 0);
  const commitPipeline = commitOpps.reduce((s, o) => s + o.amount, 0);
  const upsidePipeline = upsideOpps.reduce((s, o) => s + o.amount, 0);
  const closedWonMTD = closedWonMtdOpps.reduce((s, o) => s + o.amount, 0);

  // Team quota: sum of active rep monthly-prorated annual goals + manager prorated annual
  const year = now.getUTCFullYear();
  const repQuarterlyTotal = activeReps.reduce(
    (s, r) => s + (r.quarterlyGoals[quarter] || 0),
    0,
  );
  // Monthly portion of quarterly goal
  const teamMonthlyRepQuota = repQuarterlyTotal / 3;
  const managerQuota = input.managerQuotas.find(m => m.year === year);
  const managerMonthlyQuota = managerQuota ? managerQuota.annualAmount / 12 : 0;
  const teamQuota = teamMonthlyRepQuota + managerMonthlyQuota;

  const managerCommitRec = input.monthlyManagerCommits.find(m => m.monthKey === monthKey);
  const managerCommit = managerCommitRec?.commitAmount || teamQuota;
  const pipelineCoverage = managerCommit > 0 ? totalOpenPipeline / managerCommit : 0;

  // Changes since last import
  const lastImportEntries = lastImport
    ? input.changelog.filter(c => c.fileName === lastImport.fileName && c.importDate === lastImport.date)
    : [];

  const oppById = new Map(opps.map(o => [o.id, o]));
  const findOpp = (id: string) => oppById.get(id);

  const newOppIds = new Set(
    opps.filter(o => o.importDate === lastImportDate).map(o => o.id),
  );
  // Heuristic: new = no prior changelog entry for this opp before last import
  const seenBeforeIds = new Set(
    input.changelog
      .filter(c => c.importDate < lastImportDate)
      .map(c => c.opportunityId),
  );
  const newDeals = topByAmount(
    [...newOppIds]
      .filter(id => !seenBeforeIds.has(id))
      .map(id => findOpp(id))
      .filter((o): o is Opportunity => !!o && isOpen(o))
      .map(o => ({
        name: o.name,
        rep: o.repName,
        amount: o.amount,
        closeDate: o.closeDate,
        classification: o.classification,
      })),
  );

  const lostDeals = topByAmount(
    lastImportEntries
      .filter(e => e.field === 'classification' && (e.newValue === 'lost' || e.newValue === 'rejected'))
      .map(e => {
        const o = findOpp(e.opportunityId);
        return { name: e.opportunityName, rep: e.repName, amount: o?.amount || 0 };
      }),
  );

  const pushedDeals = topByAmount(
    lastImportEntries
      .filter(e => e.field === 'closeDate' && e.oldValue && e.newValue && e.oldValue < e.newValue)
      .map(e => {
        const o = findOpp(e.opportunityId);
        return {
          name: e.opportunityName,
          rep: e.repName,
          amount: o?.amount || 0,
          oldClose: e.oldValue,
          newClose: e.newValue,
        };
      }),
  );

  const classificationChanges = topByAmount(
    lastImportEntries
      .filter(e => e.field === 'classification')
      .map(e => {
        const o = findOpp(e.opportunityId);
        return {
          name: e.opportunityName,
          rep: e.repName,
          amount: o?.amount || 0,
          from: e.oldValue,
          to: e.newValue,
        };
      }),
  );

  const amountChanges = topByAmount(
    lastImportEntries
      .filter(e => e.field === 'amount')
      .map(e => {
        const o = findOpp(e.opportunityId);
        const oldA = parseFloat(e.oldValue) || 0;
        const newA = parseFloat(e.newValue) || 0;
        return {
          name: e.opportunityName,
          rep: e.repName,
          amount: Math.abs(newA - oldA),
          oldAmount: oldA,
          newAmount: newA,
        };
      })
      .map(({ amount, ...rest }) => ({ ...rest, amount })),
  ).map(({ amount: _absDelta, ...rest }) => rest);

  // Closing this week / next week (ISO Mon-Sun)
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = today.getUTCDay() || 7;
  const weekStart = new Date(today); weekStart.setUTCDate(today.getUTCDate() - (dow - 1));
  const weekEnd = new Date(weekStart); weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
  const nextWeekStart = new Date(weekEnd); nextWeekStart.setUTCDate(weekEnd.getUTCDate() + 1);
  const nextWeekEnd = new Date(nextWeekStart); nextWeekEnd.setUTCDate(nextWeekStart.getUTCDate() + 6);

  const dateInRange = (s: string, a: Date, b: Date) => {
    const d = new Date(s); if (isNaN(d.getTime())) return false;
    return d >= a && d <= b;
  };

  const closingThisWeek = topByAmount(
    openOpps.filter(o => dateInRange(o.closeDate, weekStart, weekEnd)).map(o => ({
      name: o.name, rep: o.repName, amount: o.amount, closeDate: o.closeDate, classification: o.classification,
    })),
  );
  const closingNextWeek = topByAmount(
    openOpps.filter(o => dateInRange(o.closeDate, nextWeekStart, nextWeekEnd)).map(o => ({
      name: o.name, rep: o.repName, amount: o.amount, closeDate: o.closeDate, classification: o.classification,
    })),
  );

  // Past-due commits: classified commit, close date already passed, not closed
  const todayLocal = new Date();
  todayLocal.setHours(0, 0, 0, 0);
  const pastDueCommits = topByAmount(
    commitOpps.filter(o => {
      const d = parseDateLocal(o.closeDate);
      if (!d) return false;
      return (
        o.stage !== 'Closed Won' &&
        o.stage !== 'Closed Lost' &&
        o.stage !== 'Rejected' &&
        d < todayLocal
      );
    }).map(o => ({
      name: o.name, rep: o.repName, amount: o.amount, closeDate: o.closeDate,
    })),
  );

  const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // Per-rep summaries
  const repSummaries = activeReps.map(rep => {
    const repOpps = opps.filter(o => o.repName.toLowerCase().trim() === rep.name.toLowerCase().trim());
    const open = repOpps.filter(isOpen);
    const commits = repOpps.filter(isCommit);
    const upsides = repOpps.filter(o => o.classification === 'upside');
    const cwMtd = repOpps.filter(o => o.classification === 'closed_won' && inMonth(o.closeDate, monthKey));

    // Stale = open & importDate older than 30 days from now
    const cutoff = Date.now() - 30 * 86400000;
    const stale = open.filter(o => {
      const t = new Date(o.importDate).getTime();
      return isFinite(t) && t < cutoff;
    });

    const changes = lastImportEntries
      .filter(e => e.repName.toLowerCase().trim() === rep.name.toLowerCase().trim())
      .slice(0, 5)
      .map(e => ({
        name: e.opportunityName,
        type: e.field,
        detail: `${e.oldValue || '∅'} → ${e.newValue || '∅'}`,
      }));

    const upsideDeals = topByAmount(upsides.map(o => ({ name: o.name, amount: o.amount, closeDate: o.closeDate })), 5);

    const currentMonthCommits = commits.filter(o => o.closeDate?.slice(0, 7) === thisMonthKey);
    const futureCommitDeals = commits.filter(o => o.closeDate?.slice(0, 7) > thisMonthKey);

    return {
      repName: rep.name,
      openPipeline: open.reduce((s, o) => s + o.amount, 0),
      commitPipeline: commits.reduce((s, o) => s + o.amount, 0),
      closedWonMTD: cwMtd.reduce((s, o) => s + o.amount, 0),
      staleDealCount: stale.length,
      commitDeals: topByAmount(currentMonthCommits.map(o => ({
        name: o.name, amount: o.amount, closeDate: o.closeDate, weekLabel: getWeekLabel(o.closeDate, thisMonthKey),
      })), 5),
      futureCommits: futureCommitDeals.map(o => ({ name: o.name, amount: o.amount, closeDate: o.closeDate })),
      futureCommitTotal: futureCommitDeals.reduce((s, o) => s + o.amount, 0),
      ...(upsideDeals.length > 0 ? { upsideDeals } : {}),
      changesSinceLastImport: changes,
    };
  }).filter(r =>
    r.openPipeline > 0 || r.commitPipeline > 0 || r.closedWonMTD > 0 || r.changesSinceLastImport.length > 0,
  );

  // DR signals
  const drs = input.dealRegistrations || [];
  const drSignals = drs.length === 0 ? null : (() => {
    const openDrs = drs.filter(d => d.status !== 'closed_won' && d.status !== 'closed_lost' && d.status !== 'rejected' && d.status !== 'withdrawn' && d.status !== 'converted');
    const stale = drs.filter(d => d.status === 'stale');
    const rejected = drs.filter(d => d.status === 'rejected');
    const camCounts = new Map<string, number>();
    for (const d of openDrs) {
      const c = d.channelAccountManager?.trim();
      if (c) camCounts.set(c, (camCounts.get(c) || 0) + 1);
    }
    const topCams = [...camCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cam, openCount]) => ({ cam, openCount }));

    // Reseller signals — only resellers with 3+ DRs
    const byReseller = new Map<string, DealRegistration[]>();
    for (const d of drs) {
      const name = d.resolvedReseller?.trim();
      if (!name) continue;
      const arr = byReseller.get(name) || [];
      arr.push(d);
      byReseller.set(name, arr);
    }
    const resellerStats = [...byReseller.entries()]
      .filter(([, arr]) => arr.filter(d => d.status !== 'rejected').length >= 3)
      .map(([name, arr]) => {
        const nonRej = arr.filter(d => d.status !== 'rejected');
        const totalDrs = nonRej.length;
        const closedWon = nonRej.filter(d => d.status === 'closed_won').length;
        const cohortRate = totalDrs ? closedWon / totalDrs : 0;
        return { name, totalDrs, closedWon, cohortRate };
      });
    const topResellers = [...resellerStats]
      .sort((a, b) => b.cohortRate - a.cohortRate)
      .slice(0, 5)
      .map(({ name, totalDrs, cohortRate, closedWon }) => ({ name, totalDrs, cohortRate, closedWon }));
    const lowResellers = resellerStats
      .filter(r => r.totalDrs >= 20 && r.cohortRate < 0.05)
      .map(({ name, totalDrs, cohortRate }) => ({ name, totalDrs, cohortRate }));

    return {
      totalOpenDrs: openDrs.length,
      staleDrCount: stale.length,
      rejectedCount: rejected.length,
      topCams,
      topResellers,
      lowResellers,
      dataFloor: 'July 15, 2025',
      dataNote: 'Closed won matches reflect formally registered deals only',
    };
  })();

  return {
    mode: input.mode,
    generatedAt: now.toISOString(),
    lastImportDate,
    lastImportFile,
    currentMonth: monthLabel,
    currentQuarter: quarter,
    daysLeftInMonth: daysLeftInMonth(now),
    teamQuota,
    managerCommit,
    closedWonMTD,
    totalOpenPipeline,
    commitPipeline,
    upsidePipeline,
    pipelineCoverage,
    newDeals,
    lostDeals,
    pushedDeals,
    classificationChanges,
    amountChanges,
    repSummaries,
    drSignals,
    closingThisWeek,
    closingNextWeek,
    pastDueCommits,
  };
}

export function formatBriefingUserMessage(payload: BriefingPayload): string {
  const fmt = (n: number) => `$${Math.round(n).toLocaleString()}`;
  return `Here is the current sales data. Generate the briefing now.

Mode: ${payload.mode}
Generated: ${payload.generatedAt}
Last import: ${payload.lastImportFile || '(none)'} on ${payload.lastImportDate || '(none)'}
Current period: ${payload.currentMonth} (${payload.daysLeftInMonth} days remaining), ${payload.currentQuarter}

TEAM METRICS
Team quota (monthly, AE + manager prorated): ${fmt(payload.teamQuota)}
Manager commit (monthly): ${fmt(payload.managerCommit)}
Closed Won MTD: ${fmt(payload.closedWonMTD)}
Open pipeline: ${fmt(payload.totalOpenPipeline)}
Commit pipeline: ${fmt(payload.commitPipeline)}
Upside pipeline: ${fmt(payload.upsidePipeline)}
Coverage: ${(payload.pipelineCoverage * 100).toFixed(0)}%

CHANGES SINCE LAST IMPORT
New deals (${payload.newDeals.length}): ${JSON.stringify(payload.newDeals)}
Lost deals (${payload.lostDeals.length}): ${JSON.stringify(payload.lostDeals)}
Pushed deals (${payload.pushedDeals.length}): ${JSON.stringify(payload.pushedDeals)}
Classification changes (${payload.classificationChanges.length}): ${JSON.stringify(payload.classificationChanges)}
Amount changes (${payload.amountChanges.length}): ${JSON.stringify(payload.amountChanges)}

CLOSING THIS WEEK (${payload.closingThisWeek.length}): ${JSON.stringify(payload.closingThisWeek)}
CLOSING NEXT WEEK (${payload.closingNextWeek.length}): ${JSON.stringify(payload.closingNextWeek)}
PAST DUE COMMITS (${payload.pastDueCommits.length}): ${JSON.stringify(payload.pastDueCommits)}

REP SUMMARIES (${payload.repSummaries.length} active reps):
${payload.repSummaries.map(r => JSON.stringify(r)).join('\n')}

${payload.drSignals ? `DR SIGNALS: ${JSON.stringify(payload.drSignals)}` : 'DR SIGNALS: (no DR data imported)'}`;
}
