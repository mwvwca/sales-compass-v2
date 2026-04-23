export interface Rep {
  id: string;
  name: string;
  quarterlyGoals: Record<string, number>;
}

export interface RepCommissionSettings {
  monthlyQuota: number;
  annualVariableComp?: number;
  baseRate?: number;
}

export type CommissionSettingsMap = Record<string, RepCommissionSettings>;

export interface CommissionOpportunityReview {
  actualCommission?: number;
  note?: string;
}

export interface CommissionMonthlyReview {
  repKey: string;
  repName: string;
  monthKey: string;
  actualTotal?: number;
  opportunities: Record<string, CommissionOpportunityReview>;
}

export type CommissionReviewsMap = Record<string, CommissionMonthlyReview>;

export interface Opportunity {
  id: string;
  name: string;
  repId: string;
  repName: string;
  amount: number;
  closeDate: string;
  stage: string;
  classification: 'commit' | 'upside' | 'closed_won' | 'unclassified' | 'lost' | 'omitted';
  probability: number;
  importDate: string;
  previousClassification?: 'commit' | 'upside' | 'closed_won' | 'unclassified' | 'lost' | 'omitted';
  lostDate?: string;
  lostReason?: string;
  movedAt?: string;
  notes?: string;
}

export interface ImportRecord {
  id: string;
  date: string;
  fileName: string;
  opportunityCount: number;
}

export interface ChangeLogEntry {
  id: string;
  importDate: string;
  fileName: string;
  opportunityId: string;
  opportunityName: string;
  repName: string;
  field: 'closeDate' | 'amount' | 'stage' | 'classification' | 'name' | 'repName';
  oldValue: string;
  newValue: string;
}

/** Snapshot of an opportunity captured at each import for history tracking. */
export interface OpportunitySnapshot {
  opportunityId: string;
  importDate: string;
  fileName: string;
  amount: number;
  closeDate: string;
  stage: string;
  classification: string;
  name: string;
  repName: string;
}

export type Quarter = `${number}-Q${1 | 2 | 3 | 4}`;

/** Parse a date string into year/month/day using UTC to avoid timezone shifts. */
function parseDate(date: string): { year: number; month: number; day: number } {
  const d = new Date(date);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function getQuarter(date: string): Quarter {
  const { year, month } = parseDate(date);
  const q = Math.ceil(month / 3) as 1 | 2 | 3 | 4;
  return `${year}-Q${q}`;
}

export function getMonthKey(date: string): string {
  const { year, month } = parseDate(date);
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function getDateAtUtcStart(date: string): Date {
  const { year, month, day } = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day));
}

export function getMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-');
  const date = new Date(parseInt(year), parseInt(month) - 1);
  return date.toLocaleString('default', { month: 'short', year: '2-digit' });
}

export function getQuarterMonths(quarter: Quarter): string[] {
  const [year, q] = quarter.split('-Q');
  const startMonth = (parseInt(q) - 1) * 3;
  return [0, 1, 2].map(i => `${year}-${String(startMonth + i + 1).padStart(2, '0')}`);
}

export function getCurrentQuarter(): Quarter {
  return getQuarter(new Date().toISOString());
}

export interface WeekRange {
  label: string;
  start: Date;
  end: Date;
}

/** Returns work week ranges for a given month key (e.g. "2025-01").
 *  W1 starts on the 1st of the month (even mid-week) and ends on the first Friday.
 *  Subsequent weeks run Monday–Friday. The last week extends to the last business
 *  day of the month. All dates are UTC-based to match opportunity date parsing. */
export function getWeeksInMonth(monthKey: string): WeekRange[] {
  const [year, month] = monthKey.split('-').map(Number);
  const weeks: WeekRange[] = [];
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const lastDay = new Date(Date.UTC(year, month, 0));

  const dow = firstDay.getUTCDay();
  let firstFriday = new Date(firstDay);
  if (dow === 0) {
    firstFriday.setUTCDate(firstFriday.getUTCDate() + 5);
  } else if (dow === 6) {
    firstFriday.setUTCDate(firstFriday.getUTCDate() + 6);
  } else {
    firstFriday.setUTCDate(firstFriday.getUTCDate() + (5 - dow));
  }
  if (firstFriday > lastDay) firstFriday = new Date(lastDay);
  const w1End = new Date(firstFriday);
  w1End.setUTCHours(23, 59, 59, 999);
  weeks.push({ label: 'W1', start: new Date(firstDay), end: w1End });

  let cursor = new Date(firstFriday);
  cursor.setUTCDate(cursor.getUTCDate() + 3);

  let weekNum = 1;
  while (cursor <= lastDay) {
    weekNum++;
    const start = new Date(cursor);
    const friday = new Date(cursor);
    friday.setUTCDate(friday.getUTCDate() + 4);
    const endDate = friday > lastDay ? new Date(lastDay) : new Date(friday);
    endDate.setUTCHours(23, 59, 59, 999);
    weeks.push({ label: `W${weekNum}`, start, end: endDate });
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }

  return weeks;
}
