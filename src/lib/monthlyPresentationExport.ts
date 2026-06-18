import * as XLSX from '@e965/xlsx';
import type { Opportunity, Rep, MonthlyRepCommit, DealRegistration } from '@/types/forecast';
import { getDateAtUtcStart } from '@/types/forecast';
import { normalizeRepName } from '@/lib/repUtils';
import { sfdcOpportunityUrl, buildAccountUrlMap, accountUrlForOpportunity } from '@/lib/sfdc';

export interface MonthlyPresentationContext {
  opportunities: Opportunity[];
  reps: Rep[];
  monthlyRepCommits: MonthlyRepCommit[];
  /** Registered deals — source of account Lightning links (Opportunity has none). */
  dealRegistrations?: DealRegistration[];
}

interface WeekRow {
  weekNum: number;
  start: Date;
  end: Date;
  label: string;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Compute the default target month key for the monthly presentation export. Always next calendar month from today. */
export function getDefaultPresentationMonth(today: Date = new Date()): string {
  const y = today.getFullYear();
  const m = today.getMonth() + 1; // 1-12, next month
  const targetY = m === 12 ? y + 1 : y;
  const targetM = m === 12 ? 1 : m + 1;
  return `${targetY}-${String(targetM).padStart(2, '0')}`;
}

export function getPresentationButtonLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  return `Monthly Presentation — ${MONTH_ABBR[m - 1]} ${y}`;
}

/** Build Mon–Sun ISO weeks that overlap the target month. Labels clipped to month boundaries when displayed. */
function buildWeeks(monthStart: Date, monthEnd: Date): WeekRow[] {
  const weeks: WeekRow[] = [];
  // Find Monday on/before monthStart
  const dow = monthStart.getUTCDay() || 7; // 1..7 (Sun=7)
  const firstMon = new Date(monthStart);
  firstMon.setUTCDate(firstMon.getUTCDate() - (dow - 1));

  let cursor = new Date(firstMon);
  let weekNum = 1;
  while (cursor <= monthEnd) {
    const start = new Date(cursor);
    const end = new Date(cursor);
    end.setUTCDate(end.getUTCDate() + 6);
    end.setUTCHours(23, 59, 59, 999);

    // Skip weeks fully before month start (shouldn't happen, but safety)
    if (end < monthStart) {
      cursor.setUTCDate(cursor.getUTCDate() + 7);
      continue;
    }

    const dispStart = start < monthStart ? monthStart : start;
    const dispEnd = end > monthEnd ? monthEnd : end;
    weeks.push({
      weekNum,
      start,
      end,
      label: formatWeekLabel(dispStart, dispEnd),
    });
    weekNum++;
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return weeks;
}

function formatWeekLabel(start: Date, end: Date): string {
  const sM = MONTH_ABBR[start.getUTCMonth()];
  const eM = MONTH_ABBR[end.getUTCMonth()];
  if (sM === eM) return `${sM} ${start.getUTCDate()}–${end.getUTCDate()}`;
  return `${sM} ${start.getUTCDate()}–${eM} ${end.getUTCDate()}`;
}

function classificationLabel(o: Opportunity): 'Commit' | 'Upside' | 'Pipeline' | 'Closed Won' {
  if (o.classification === 'commit') return 'Commit';
  if (o.classification === 'upside') return 'Upside';
  if (o.classification === 'closed_won') return 'Closed Won';
  return 'Pipeline';
}

// Styling
const NAVY = 'FF1C2B4A';
const NAVY_MED = 'FF2E4272';
const WHITE = 'FFFFFFFF';
const ALT_GRAY = 'FFFAFAFA';
const COMMIT_BG = 'FFE8F5E9';
const UPSIDE_BG = 'FFFFF8DC';
const LOST_BG = 'FFFDECEA';
const AMBER = 'FFB7791F';
const GREEN = 'FF2F855A';
const RED = 'FFC53030';

const FONT = { name: 'Arial', sz: 10 } as const;
const headerStyle = { fill: { fgColor: { rgb: NAVY } }, font: { name: 'Arial', color: { rgb: WHITE }, bold: true, sz: 10 }, alignment: { horizontal: 'center', vertical: 'center' } };
const titleStyle = { font: { name: 'Arial', bold: true, sz: 16 }, alignment: { horizontal: 'left' } };
const subtitleStyle = { font: { name: 'Arial', italic: true, sz: 10, color: { rgb: 'FF666666' } } };
const kpiLabelStyle = { font: { name: 'Arial', bold: true, sz: 10 }, fill: { fgColor: { rgb: NAVY_MED } }, ...{ font: { name: 'Arial', bold: true, sz: 10, color: { rgb: WHITE } } }, alignment: { horizontal: 'center' } };
const kpiValueStyle = (color?: string) => ({ font: { name: 'Arial', bold: true, sz: 14, color: color ? { rgb: color } : undefined }, alignment: { horizontal: 'center' }, numFmt: '$#,##0' });
const moneyStyle = { font: FONT, numFmt: '$#,##0' };
const pctStyle = (color?: string) => ({ font: { name: 'Arial', sz: 10, color: color ? { rgb: color } : undefined, bold: !!color }, numFmt: '0%' });
const cellStyle = (bg?: string) => ({ font: FONT, ...(bg ? { fill: { fgColor: { rgb: bg } } } : {}) });
const boldCellStyle = (bg?: string) => ({ font: { name: 'Arial', sz: 10, bold: true }, ...(bg ? { fill: { fgColor: { rgb: bg } } } : {}) });

function coverageColor(pct: number): string {
  if (pct >= 1.2) return GREEN;
  if (pct >= 0.8) return AMBER;
  return RED;
}
function progressColor(pct: number): string {
  if (pct >= 1.0) return GREEN;
  if (pct >= 0.7) return AMBER;
  return RED;
}

function ensureCell(ws: XLSX.WorkSheet, addr: string, value: any, style?: any, type?: 's' | 'n', link?: string) {
  const t = type || (typeof value === 'number' ? 'n' : 's');
  const cell: any = { v: value, t };
  if (style) cell.s = style;
  if (link) cell.l = { Target: link, Tooltip: 'Open in Salesforce' };
  ws[addr] = cell;
}

function expandRange(ws: XLSX.WorkSheet, rEnd: number, cEnd: number) {
  const prev = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
  prev.e.r = Math.max(prev.e.r, rEnd);
  prev.e.c = Math.max(prev.e.c, cEnd);
  ws['!ref'] = XLSX.utils.encode_range(prev);
}

export function exportMonthlyPresentation(monthKey: string, ctx: MonthlyPresentationContext): void {
  const [year, month] = monthKey.split('-').map(Number);
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  const monthFull = `${MONTH_FULL[month - 1]} ${year}`;
  const monthAbbr = `${MONTH_ABBR[month - 1]} ${year}`;

  // Account Lightning links, derived from registered deals (Opportunity has no account URL).
  const acctUrlMap = buildAccountUrlMap(ctx.dealRegistrations ?? []);

  const weeks = buildWeeks(monthStart, monthEnd);

  const inMonth = (d: string) => {
    if (!d) return false;
    const dt = getDateAtUtcStart(d);
    return dt >= monthStart && dt <= monthEnd;
  };
  const weekOf = (d: string): WeekRow | null => {
    const dt = getDateAtUtcStart(d);
    return weeks.find(w => dt >= w.start && dt <= w.end) || null;
  };

  const activeOpps = ctx.opportunities.filter(o => {
    if (!inMonth(o.closeDate)) return false;
    if (o.classification === 'lost' || o.classification === 'omitted' || o.classification === 'rejected') return false;
    const s = o.stage.toLowerCase().trim();
    if (s === 'closed lost') return false;
    if (s.includes('reject')) return false;
    return true;
  });
  const lostOpps = ctx.opportunities.filter(o => {
    if (!inMonth(o.closeDate)) return false;
    return o.classification === 'lost' || o.stage.toLowerCase().trim() === 'closed lost';
  });

  const monthCommits = ctx.monthlyRepCommits.filter(c => c.monthKey === monthKey);
  const totalMgmtCommit = monthCommits.reduce((s, c) => s + (c.commitAmount || 0), 0);

  // AE quota for month = sum of (rep quarterly goal for the quarter containing this month) / 3
  const q = `${year}-Q${Math.ceil(month / 3)}` as const;
  const totalAEQuota = ctx.reps.reduce((s, r) => s + ((r.quarterlyGoals[q] || 0) / 3), 0);

  const totalPipeline = activeOpps.reduce((s, o) => s + o.amount, 0);
  const closedWon = activeOpps.filter(o => o.classification === 'closed_won').reduce((s, o) => s + o.amount, 0);
  const coverage = totalMgmtCommit > 0 ? totalPipeline / totalMgmtCommit : 0;

  const hasCAM = activeOpps.some(o => o.channelAccountManager && o.channelAccountManager.trim());

  const wb = XLSX.utils.book_new();

  // ============== Sheet 1: Monthly Overview ==============
  const ws1: XLSX.WorkSheet = {};
  let r = 0;

  ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 0 }), `${monthFull} — Pipeline Presentation`, titleStyle);
  r++;
  ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 0 }), `Generated ${new Date().toLocaleDateString('en-US', { dateStyle: 'full' })}  ·  Confidential`, subtitleStyle);
  r++;
  r++; // spacer

  // KPI block
  const kpiLabels = ['AE Quota', 'Mgmt Commit', 'Total Pipeline', 'Closed Won (MTD)', 'Coverage'];
  kpiLabels.forEach((l, i) => ensureCell(ws1, XLSX.utils.encode_cell({ r, c: i }), l, kpiLabelStyle));
  r++;
  ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 0 }), totalAEQuota, kpiValueStyle(), 'n');
  if (totalMgmtCommit > 0) {
    ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 1 }), totalMgmtCommit, kpiValueStyle(), 'n');
  } else {
    ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 1 }), 'Not Set', { font: { name: 'Arial', bold: true, sz: 14, color: { rgb: AMBER } }, alignment: { horizontal: 'center' } });
  }
  ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 2 }), totalPipeline, kpiValueStyle(), 'n');
  ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 3 }), closedWon, kpiValueStyle(GREEN), 'n');
  if (totalMgmtCommit > 0) {
    ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 4 }), coverage, { font: { name: 'Arial', bold: true, sz: 14, color: { rgb: coverageColor(coverage) } }, alignment: { horizontal: 'center' }, numFmt: '0%' }, 'n');
  } else {
    ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 4 }), '—', { font: { name: 'Arial', bold: true, sz: 14 }, alignment: { horizontal: 'center' } });
  }
  r++;
  r++; // spacer

  // Week-by-week breakdown
  const wkHeader = ['Week', 'Dates', '# Deals', 'Commit $', 'Upside $', 'Total $', 'Cumulative $', 'vs Mgmt Commit'];
  wkHeader.forEach((h, i) => ensureCell(ws1, XLSX.utils.encode_cell({ r, c: i }), h, headerStyle));
  r++;

  let cum = 0;
  let totDeals = 0, totCommit = 0, totUpside = 0, totTotal = 0;
  weeks.forEach((w, idx) => {
    const wkOpps = activeOpps.filter(o => {
      const wk = weekOf(o.closeDate);
      return wk && wk.weekNum === w.weekNum;
    });
    const commit = wkOpps.filter(o => o.classification === 'commit').reduce((s, o) => s + o.amount, 0);
    const upside = wkOpps.filter(o => o.classification === 'upside').reduce((s, o) => s + o.amount, 0);
    const total = commit + upside;
    cum += total;
    const vsCommit = totalMgmtCommit > 0 ? cum / totalMgmtCommit : 0;
    const altBg = idx % 2 === 1 ? ALT_GRAY : undefined;

    ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 0 }), `Week ${w.weekNum}`, cellStyle(altBg));
    ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 1 }), w.label, cellStyle(altBg));
    ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 2 }), wkOpps.length, cellStyle(altBg), 'n');
    ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 3 }), commit, { ...moneyStyle, ...(altBg ? { fill: { fgColor: { rgb: altBg } } } : {}) }, 'n');
    ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 4 }), upside, { ...moneyStyle, ...(altBg ? { fill: { fgColor: { rgb: altBg } } } : {}) }, 'n');
    ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 5 }), total, { ...moneyStyle, ...(altBg ? { fill: { fgColor: { rgb: altBg } } } : {}) }, 'n');
    ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 6 }), cum, { ...moneyStyle, ...(altBg ? { fill: { fgColor: { rgb: altBg } } } : {}) }, 'n');
    if (totalMgmtCommit > 0) {
      ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 7 }), vsCommit, { ...pctStyle(progressColor(vsCommit)), ...(altBg ? { fill: { fgColor: { rgb: altBg } } } : {}) }, 'n');
    } else {
      ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 7 }), '—', cellStyle(altBg));
    }
    totDeals += wkOpps.length; totCommit += commit; totUpside += upside; totTotal += total;
    r++;
  });
  // total row
  ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 0 }), 'Total', boldCellStyle());
  ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 1 }), '', boldCellStyle());
  ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 2 }), totDeals, boldCellStyle(), 'n');
  ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 3 }), totCommit, { ...boldCellStyle(), numFmt: '$#,##0' }, 'n');
  ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 4 }), totUpside, { ...boldCellStyle(), numFmt: '$#,##0' }, 'n');
  ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 5 }), totTotal, { ...boldCellStyle(), numFmt: '$#,##0' }, 'n');
  ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 6 }), totTotal, { ...boldCellStyle(), numFmt: '$#,##0' }, 'n');
  if (totalMgmtCommit > 0) {
    ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 7 }), totTotal / totalMgmtCommit, { ...boldCellStyle(), numFmt: '0%', font: { name: 'Arial', sz: 10, bold: true, color: { rgb: progressColor(totTotal / totalMgmtCommit) } } }, 'n');
  } else {
    ensureCell(ws1, XLSX.utils.encode_cell({ r, c: 7 }), '—', boldCellStyle());
  }
  r++;
  r++; // spacer

  // Per-rep summary
  const repCols = ['Rep', 'Commit (Goal)', ...weeks.map(w => `Week ${w.weekNum}`), 'Month Total', 'vs Commit'];
  repCols.forEach((h, i) => ensureCell(ws1, XLSX.utils.encode_cell({ r, c: i }), h, headerStyle));
  r++;

  const repNames = Array.from(new Set([...ctx.reps.map(rp => rp.name), ...activeOpps.map(o => o.repName)])).sort();
  const commitByRep = new Map<string, number>();
  for (const c of monthCommits) commitByRep.set(normalizeRepName(c.repName), c.commitAmount);

  const colSums: number[] = new Array(repCols.length).fill(0);
  let totMonthAll = 0;
  let totCommitGoal = 0;

  repNames.forEach((name, idx) => {
    const altBg = idx % 2 === 1 ? ALT_GRAY : undefined;
    const repCommit = commitByRep.get(normalizeRepName(name));
    let cIdx = 0;
    ensureCell(ws1, XLSX.utils.encode_cell({ r, c: cIdx++ }), name, cellStyle(altBg));
    if (repCommit !== undefined) {
      ensureCell(ws1, XLSX.utils.encode_cell({ r, c: cIdx++ }), repCommit, { ...moneyStyle, ...(altBg ? { fill: { fgColor: { rgb: altBg } } } : {}) }, 'n');
      totCommitGoal += repCommit;
    } else {
      ensureCell(ws1, XLSX.utils.encode_cell({ r, c: cIdx++ }), '—', cellStyle(altBg));
    }
    let monthTotal = 0;
    for (const w of weeks) {
      const wkSum = activeOpps
        .filter(o => o.repName === name && o.classification === 'commit')
        .filter(o => {
          const wk = weekOf(o.closeDate);
          return wk && wk.weekNum === w.weekNum;
        })
        .reduce((s, o) => s + o.amount, 0);
      ensureCell(ws1, XLSX.utils.encode_cell({ r, c: cIdx }), wkSum, { ...moneyStyle, ...(altBg ? { fill: { fgColor: { rgb: altBg } } } : {}) }, 'n');
      colSums[cIdx] += wkSum;
      cIdx++;
      monthTotal += wkSum;
    }
    ensureCell(ws1, XLSX.utils.encode_cell({ r, c: cIdx }), monthTotal, { ...moneyStyle, ...(altBg ? { fill: { fgColor: { rgb: altBg } } } : {}) }, 'n');
    cIdx++;
    totMonthAll += monthTotal;
    if (repCommit && repCommit > 0) {
      const pct = monthTotal / repCommit;
      ensureCell(ws1, XLSX.utils.encode_cell({ r, c: cIdx }), pct, { ...pctStyle(progressColor(pct)), ...(altBg ? { fill: { fgColor: { rgb: altBg } } } : {}) }, 'n');
    } else {
      ensureCell(ws1, XLSX.utils.encode_cell({ r, c: cIdx }), '—', cellStyle(altBg));
    }
    r++;
  });
  // total row
  let cIdx = 0;
  ensureCell(ws1, XLSX.utils.encode_cell({ r, c: cIdx++ }), 'Total', boldCellStyle());
  ensureCell(ws1, XLSX.utils.encode_cell({ r, c: cIdx++ }), totCommitGoal, { ...boldCellStyle(), numFmt: '$#,##0' }, 'n');
  for (const _w of weeks) {
    ensureCell(ws1, XLSX.utils.encode_cell({ r, c: cIdx }), colSums[cIdx], { ...boldCellStyle(), numFmt: '$#,##0' }, 'n');
    cIdx++;
  }
  ensureCell(ws1, XLSX.utils.encode_cell({ r, c: cIdx++ }), totMonthAll, { ...boldCellStyle(), numFmt: '$#,##0' }, 'n');
  if (totCommitGoal > 0) {
    const pct = totMonthAll / totCommitGoal;
    ensureCell(ws1, XLSX.utils.encode_cell({ r, c: cIdx }), pct, { ...boldCellStyle(), numFmt: '0%', font: { name: 'Arial', sz: 10, bold: true, color: { rgb: progressColor(pct) } } }, 'n');
  } else {
    ensureCell(ws1, XLSX.utils.encode_cell({ r, c: cIdx }), '—', boldCellStyle());
  }
  r++;

  expandRange(ws1, r, Math.max(repCols.length - 1, 7));
  ws1['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(repCols.length - 1, 7) } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: Math.max(repCols.length - 1, 7) } },
  ];
  ws1['!cols'] = [
    { wch: 14 }, { wch: 18 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 18 },
    ...weeks.slice(8).map(() => ({ wch: 14 })),
  ];
  ws1['!freeze'] = { xSplit: 0, ySplit: 2 };
  XLSX.utils.book_append_sheet(wb, ws1, 'Monthly Overview');

  // ============== Sheet 2: Deal Detail ==============
  const ws2: XLSX.WorkSheet = {};
  r = 0;
  ensureCell(ws2, XLSX.utils.encode_cell({ r: r++, c: 0 }), `Deal Detail — ${monthFull}`, titleStyle);
  ensureCell(ws2, XLSX.utils.encode_cell({ r: r++, c: 0 }), `All active opportunities closing this month · Sorted by Classification then Close Date`, subtitleStyle);

  const detailHeader = ['Week', 'Close Date', 'Opportunity Name', 'Rep', ...(hasCAM ? ['Channel Account Manager'] : []), 'Account Name', 'Amount', 'Stage', 'Classification', 'Forecast Category', 'Product', 'Notes'];
  detailHeader.forEach((h, i) => ensureCell(ws2, XLSX.utils.encode_cell({ r, c: i }), h, headerStyle));
  const headerRow = r;
  r++;

  if (activeOpps.length === 0) {
    ensureCell(ws2, XLSX.utils.encode_cell({ r, c: 0 }), 'No active opportunities closing this month.', cellStyle());
    r++;
  } else {
    const order: Record<string, number> = { Commit: 0, Upside: 1, 'Closed Won': 2, Pipeline: 3 };
    const sorted = [...activeOpps].sort((a, b) => {
      const ca = classificationLabel(a), cb = classificationLabel(b);
      if (order[ca] !== order[cb]) return order[ca] - order[cb];
      return (a.closeDate || '').localeCompare(b.closeDate || '');
    });
    for (const o of sorted) {
      const cls = classificationLabel(o);
      const bg = cls === 'Commit' ? COMMIT_BG : cls === 'Upside' ? UPSIDE_BG : undefined;
      const wk = weekOf(o.closeDate);
      let c = 0;
      ensureCell(ws2, XLSX.utils.encode_cell({ r, c: c++ }), wk ? `Week ${wk.weekNum}` : '', cellStyle(bg));
      ensureCell(ws2, XLSX.utils.encode_cell({ r, c: c++ }), o.closeDate ? o.closeDate.slice(0, 10) : '', cellStyle(bg));
      ensureCell(ws2, XLSX.utils.encode_cell({ r, c: c++ }), o.name, cellStyle(bg), 's', o.salesforceId ? sfdcOpportunityUrl(o.salesforceId) : undefined);
      ensureCell(ws2, XLSX.utils.encode_cell({ r, c: c++ }), o.repName, cellStyle(bg));
      if (hasCAM) ensureCell(ws2, XLSX.utils.encode_cell({ r, c: c++ }), o.channelAccountManager || '', cellStyle(bg));
      ensureCell(ws2, XLSX.utils.encode_cell({ r, c: c++ }), o.accountName || '', cellStyle(bg), 's', accountUrlForOpportunity(o.salesforceId, acctUrlMap));
      ensureCell(ws2, XLSX.utils.encode_cell({ r, c: c++ }), o.amount || 0, { ...moneyStyle, ...(bg ? { fill: { fgColor: { rgb: bg } } } : {}) }, 'n');
      ensureCell(ws2, XLSX.utils.encode_cell({ r, c: c++ }), o.stage || '', cellStyle(bg));
      ensureCell(ws2, XLSX.utils.encode_cell({ r, c: c++ }), cls, cellStyle(bg));
      ensureCell(ws2, XLSX.utils.encode_cell({ r, c: c++ }), o.stage || '', cellStyle(bg));
      ensureCell(ws2, XLSX.utils.encode_cell({ r, c: c++ }), o.productName || '', cellStyle(bg));
      const notes = (o.notes || '').length > 200 ? (o.notes || '').slice(0, 200) + '…' : (o.notes || '');
      ensureCell(ws2, XLSX.utils.encode_cell({ r, c: c++ }), notes, cellStyle(bg));
      r++;
    }
  }

  expandRange(ws2, r, detailHeader.length - 1);
  ws2['!cols'] = detailHeader.map((h) => {
    if (h === 'Opportunity Name') return { wch: 42 };
    if (h === 'Rep' || h === 'Channel Account Manager') return { wch: 20 };
    if (h === 'Amount') return { wch: 14 };
    if (h === 'Week' || h === 'Close Date') return { wch: 12 };
    if (h === 'Notes') return { wch: 35 };
    return { wch: 16 };
  });
  ws2['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: headerRow, c: 0 }, e: { r: Math.max(r - 1, headerRow), c: detailHeader.length - 1 } }) };
  ws2['!freeze'] = { xSplit: 0, ySplit: headerRow + 1 };
  ws2['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: detailHeader.length - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: detailHeader.length - 1 } },
  ];
  XLSX.utils.book_append_sheet(wb, ws2, 'Deal Detail');

  // ============== Sheet 3: Rep Commits ==============
  const ws3: XLSX.WorkSheet = {};
  r = 0;
  ensureCell(ws3, XLSX.utils.encode_cell({ r: r++, c: 0 }), `Management Commits — ${monthFull}`, titleStyle);
  ensureCell(ws3, XLSX.utils.encode_cell({ r: r++, c: 0 }), `Per-rep commits entered at month start · Source of truth for leadership rollup`, subtitleStyle);

  const cHeader = ['Rep Name', 'Monthly Commit', 'Quarterly Quota', 'Monthly Quota (Q/3)', 'Gap', '1:1 Notes', 'Last Updated'];
  cHeader.forEach((h, i) => ensureCell(ws3, XLSX.utils.encode_cell({ r, c: i }), h, headerStyle));
  const cHeaderRow = r;
  r++;

  const commitByRepId = new Map<string, MonthlyRepCommit>();
  for (const c of monthCommits) {
    commitByRepId.set(normalizeRepName(c.repName), c);
    if (c.repId) commitByRepId.set(c.repId, c);
  }

  let sumCommit = 0, sumMonthlyQ = 0;
  for (const rep of ctx.reps) {
    const commit = commitByRepId.get(rep.id) || commitByRepId.get(normalizeRepName(rep.name));
    const qq = rep.quarterlyGoals[q] || 0;
    const mq = qq / 3;
    const commitAmt = commit?.commitAmount;
    const gap = (commitAmt || 0) - mq;
    const altBg = undefined;
    let c = 0;
    ensureCell(ws3, XLSX.utils.encode_cell({ r, c: c++ }), rep.name, cellStyle(altBg));
    if (commitAmt !== undefined) {
      ensureCell(ws3, XLSX.utils.encode_cell({ r, c: c++ }), commitAmt, moneyStyle, 'n');
      sumCommit += commitAmt;
    } else {
      ensureCell(ws3, XLSX.utils.encode_cell({ r, c: c++ }), 'Not Set', { font: { name: 'Arial', sz: 10, color: { rgb: AMBER }, bold: true } });
    }
    ensureCell(ws3, XLSX.utils.encode_cell({ r, c: c++ }), qq, moneyStyle, 'n');
    ensureCell(ws3, XLSX.utils.encode_cell({ r, c: c++ }), mq, moneyStyle, 'n');
    sumMonthlyQ += mq;
    if (commitAmt !== undefined) {
      ensureCell(ws3, XLSX.utils.encode_cell({ r, c: c++ }), gap, { font: { name: 'Arial', sz: 10, bold: true, color: { rgb: gap < 0 ? RED : GREEN } }, numFmt: '$#,##0' }, 'n');
    } else {
      ensureCell(ws3, XLSX.utils.encode_cell({ r, c: c++ }), '—', cellStyle());
    }
    ensureCell(ws3, XLSX.utils.encode_cell({ r, c: c++ }), commit?.notes || '', cellStyle());
    ensureCell(ws3, XLSX.utils.encode_cell({ r, c: c++ }), commit?.updatedAt ? new Date(commit.updatedAt).toLocaleString() : '', cellStyle());
    r++;
  }
  // total
  ensureCell(ws3, XLSX.utils.encode_cell({ r, c: 0 }), 'Total', boldCellStyle());
  ensureCell(ws3, XLSX.utils.encode_cell({ r, c: 1 }), sumCommit, { ...boldCellStyle(), numFmt: '$#,##0' }, 'n');
  ensureCell(ws3, XLSX.utils.encode_cell({ r, c: 2 }), ctx.reps.reduce((s, rp) => s + (rp.quarterlyGoals[q] || 0), 0), { ...boldCellStyle(), numFmt: '$#,##0' }, 'n');
  ensureCell(ws3, XLSX.utils.encode_cell({ r, c: 3 }), sumMonthlyQ, { ...boldCellStyle(), numFmt: '$#,##0' }, 'n');
  ensureCell(ws3, XLSX.utils.encode_cell({ r, c: 4 }), sumCommit - sumMonthlyQ, { ...boldCellStyle(), numFmt: '$#,##0', font: { name: 'Arial', sz: 10, bold: true, color: { rgb: (sumCommit - sumMonthlyQ) < 0 ? RED : GREEN } } }, 'n');
  r++;

  expandRange(ws3, r, cHeader.length - 1);
  ws3['!cols'] = [{ wch: 24 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 35 }, { wch: 20 }];
  ws3['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: cHeaderRow, c: 0 }, e: { r: Math.max(r - 1, cHeaderRow), c: cHeader.length - 1 } }) };
  ws3['!freeze'] = { xSplit: 0, ySplit: cHeaderRow + 1 };
  ws3['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: cHeader.length - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: cHeader.length - 1 } },
  ];
  XLSX.utils.book_append_sheet(wb, ws3, 'Rep Commits');

  // ============== Sheet 4: Lost This Month ==============
  const ws4: XLSX.WorkSheet = {};
  r = 0;
  ensureCell(ws4, XLSX.utils.encode_cell({ r: r++, c: 0 }), `Lost This Month — ${monthFull}`, titleStyle);
  ensureCell(ws4, XLSX.utils.encode_cell({ r: r++, c: 0 }), `Opportunities that closed lost during this period`, subtitleStyle);
  const lostTotal = lostOpps.reduce((s, o) => s + o.amount, 0);
  ensureCell(ws4, XLSX.utils.encode_cell({ r: r++, c: 0 }), `${lostOpps.length} deals lost · $${lostTotal.toLocaleString()} total value`, boldCellStyle());

  const lHeader = ['Close Date', 'Opportunity Name', 'Rep', 'Amount', 'Last Stage', 'Account Name', 'Product'];
  lHeader.forEach((h, i) => ensureCell(ws4, XLSX.utils.encode_cell({ r, c: i }), h, headerStyle));
  const lHeaderRow = r;
  r++;

  if (lostOpps.length === 0) {
    ensureCell(ws4, XLSX.utils.encode_cell({ r, c: 0 }), 'No deals closed lost this month.', cellStyle());
    r++;
  } else {
    const sorted = [...lostOpps].sort((a, b) => (a.closeDate || '').localeCompare(b.closeDate || ''));
    for (const o of sorted) {
      let c = 0;
      ensureCell(ws4, XLSX.utils.encode_cell({ r, c: c++ }), o.closeDate ? o.closeDate.slice(0, 10) : '', cellStyle(LOST_BG));
      ensureCell(ws4, XLSX.utils.encode_cell({ r, c: c++ }), o.name, cellStyle(LOST_BG), 's', o.salesforceId ? sfdcOpportunityUrl(o.salesforceId) : undefined);
      ensureCell(ws4, XLSX.utils.encode_cell({ r, c: c++ }), o.repName, cellStyle(LOST_BG));
      ensureCell(ws4, XLSX.utils.encode_cell({ r, c: c++ }), o.amount || 0, { ...moneyStyle, fill: { fgColor: { rgb: LOST_BG } } }, 'n');
      ensureCell(ws4, XLSX.utils.encode_cell({ r, c: c++ }), o.stage || '', cellStyle(LOST_BG));
      ensureCell(ws4, XLSX.utils.encode_cell({ r, c: c++ }), o.accountName || '', cellStyle(LOST_BG), 's', accountUrlForOpportunity(o.salesforceId, acctUrlMap));
      ensureCell(ws4, XLSX.utils.encode_cell({ r, c: c++ }), o.productName || '', cellStyle(LOST_BG));
      r++;
    }
  }
  expandRange(ws4, r, lHeader.length - 1);
  ws4['!cols'] = [{ wch: 12 }, { wch: 42 }, { wch: 20 }, { wch: 14 }, { wch: 18 }, { wch: 24 }, { wch: 20 }];
  ws4['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: lHeaderRow, c: 0 }, e: { r: Math.max(r - 1, lHeaderRow), c: lHeader.length - 1 } }) };
  ws4['!freeze'] = { xSplit: 0, ySplit: lHeaderRow + 1 };
  ws4['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lHeader.length - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lHeader.length - 1 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: lHeader.length - 1 } },
  ];
  XLSX.utils.book_append_sheet(wb, ws4, 'Lost This Month');

  XLSX.writeFile(wb, `Monthly_Presentation_${MONTH_ABBR[month - 1]}_${year}.xlsx`);
}
