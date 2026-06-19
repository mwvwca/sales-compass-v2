export interface Rep {
  id: string;
  name: string;
  quarterlyGoals: Record<string, number>;
  isActive: boolean;
  inactivatedAt?: string;
  inactivatedNote?: string;
}

export interface RepCommissionSettings {
  monthlyQuota: number;
  annualVariableComp?: number;
  priorQuarterPayout?: number;
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
  /** Salesforce Opportunity ID (e.g. '006Vy000017OsIs') — stable join key across imports/DR. */
  salesforceId?: string;
  name: string;
  repId: string;
  repName: string;
  amount: number;
  closeDate: string;
  stage: string;
  classification: 'commit' | 'upside' | 'closed_won' | 'unclassified' | 'lost' | 'omitted' | 'rejected';
  probability: number;
  importDate: string;
  previousClassification?: 'commit' | 'upside' | 'closed_won' | 'unclassified' | 'lost' | 'omitted' | 'rejected';
  lostDate?: string;
  lostReason?: string;
  movedAt?: string;
  notes?: string;
  commissionMrr?: number;
  commissionTermYears?: number;
  commissionPaymentType?: 'annual' | 'upfront';
  commissionSpiff?: number;
  commissionNotes?: string;
  accountName?: string;
  productName?: string;
  channelAccountManager?: string;
  resellerName?: string;
  forecastCategory?: string;
  distributorReseller?: string;
  /** Normalized reseller name resolved from resellerName / distributorReseller via resellerUtils. */
  resolvedReseller?: string;
  opportunitySource?: string;
  nextStep?: string;
  description?: string;
}

export interface MonthlyRepCommit {
  id: string;
  repId: string;
  repName: string;
  monthKey: string;
  commitAmount: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MonthlyManagerCommit {
  id: string;
  monthKey: string;
  commitAmount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ManagerQuota {
  id: string;
  annualAmount: number;
  year: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ForecastPromotion {
  opportunityId: string;
  monthKey: string;
  promotedAt: string;
}

export interface ForecastDealLine {
  opportunityId: string;
  opportunityName: string;
  repName: string;
  amount: number;
  closeDate: string;
  stage: string;
  classification: 'commit' | 'promoted_upside';
  weekLabel: string;
}

export interface ForecastSnapshotOutcomeLine {
  opportunityId: string;
  status: 'won' | 'lost' | 'pushed' | 'pending' | 'removed';
  closedDate?: string;
  amount: number;
  note?: string;
}

export interface ForecastSnapshot {
  id: string;
  monthKey: string;
  snapshotLabel: string;
  createdAt: string;
  managerCommit: number;
  repRollup: number;
  commitTotal: number;
  promotedUpsideTotal: number;
  totalCall: number;
  deals: ForecastDealLine[];
  closedWonTotal?: number;
  closedWonCount?: number;
  reconciledAt?: string;
  outcomes?: ForecastSnapshotOutcomeLine[];
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
  field: 'closeDate' | 'amount' | 'stage' | 'classification' | 'name' | 'repName' | 'nextStep';
  oldValue: string;
  newValue: string;
}

export type DrStatus =
  | 'active'
  | 'stale'
  | 'sql'
  | 'rejected'
  | 'withdrawn'
  | 'converted'
  | 'closed_won'
  | 'closed_lost'
  | 'padded';

export interface DrStageHistoryEntry {
  stage: string;
  probability: number;
  date: string;
  batchId: string;
}

export interface DealRegistration {
  // Identity (immutable after first import)
  opportunityId: string;
  opportunityName: string;
  accountName: string;
  accountUrl?: string;
  createdDate: string;
  batchIdFirstSeen: string;

  // People (Salesforce source of truth; updated each import)
  repName: string;
  secondOwner?: string;
  channelAccountManager?: string;
  resellerName?: string;
  distributorReseller?: string;
  /** Normalized reseller name resolved from resellerName / distributorReseller via resellerUtils. */
  resolvedReseller?: string;

  // Deal details
  product?: string;
  stage: string;
  probability: number;
  amount?: number;
  expectedRevenue?: number;
  closeDate?: string;
  billingState?: string;
  leadSource?: string;
  type?: string;
  registeredDeal: boolean;

  // AE activity
  lastActivity?: string;
  ageDays: number;

  // Lifecycle tracking
  firstSeenAt: string;
  lastSeenAt: string;
  lastUpdatedAt: string;
  stageHistory: DrStageHistoryEntry[];
  isSql: boolean;
  sqlDate?: string;

  status: DrStatus;
  rejectedAt?: string;
  convertedAt?: string;

  // Cohort/cycle analytics (populated when matched to a closed won opp)
  closedWonDate?: string;
  cycleDays?: number;
  inPeriodWon?: boolean;
}

/** Parser output / merge input — identity + mutable fields, no lifecycle. */
export type RawDrRecord = Omit<
  DealRegistration,
  | 'batchIdFirstSeen'
  | 'firstSeenAt'
  | 'lastSeenAt'
  | 'lastUpdatedAt'
  | 'stageHistory'
  | 'isSql'
  | 'sqlDate'
  | 'status'
  | 'rejectedAt'
  | 'convertedAt'
  | 'closedWonDate'
  | 'cycleDays'
  | 'inPeriodWon'
>;

export interface DrBatch {
  id: string;
  importedAt: string;
  fileName: string;
  recordCount: number;
  newCount: number;
  updatedCount: number;
  rejectedCount: number;
  convertedCount: number;
  asOfDate: string;
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

/** Friday-to-Friday weekly snapshot for week-over-week trend tracking on the forecast dashboard. */
export interface WeeklySnapshot {
  id: string;
  snapshotDate: string;       // 'YYYY-MM-DD' — the Friday this was captured
  closedWon: number;
  commitPipeline: number;
  upsidePipeline: number;
  totalPipeline: number;
  defensibleCoverage: number; // ratio (e.g. 2.3 means 2.3x)
  capturedAt: string;         // ISO timestamp
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

/** ISO-style week range (Monday–Sunday) containing the given date, in UTC. */
export function getISOWeekRange(date: Date): { start: Date; end: Date; label: string } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - (day - 1));
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);
  const fmt = (x: Date) => x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return { start, end, label: `${fmt(start)} – ${fmt(end)}` };
}

export function addDaysUTC(date: Date, n: number): Date {
  const d = new Date(date); d.setUTCDate(d.getUTCDate() + n); return d;
}

export function addMonthsUTC(date: Date, n: number): Date {
  const d = new Date(date); d.setUTCMonth(d.getUTCMonth() + n); return d;
}

export function getYearQuarters(year: number): Quarter[] {
  return [1, 2, 3, 4].map(q => `${year}-Q${q}` as Quarter);
}

/** Returns a Date set to midnight UTC on the first day of the given quarter */
export function quarterStart(quarter: Quarter): Date {
  const [year, q] = quarter.split('-Q').map(Number);
  const month = (q - 1) * 3;
  return new Date(Date.UTC(year, month, 1));
}

/** Returns a Date set to 23:59:59.999 UTC on the last day of the given quarter */
export function quarterEnd(quarter: Quarter): Date {
  const [year, q] = quarter.split('-Q').map(Number);
  const month = (q - 1) * 3 + 3;
  return new Date(Date.UTC(year, month, 1) - 1);
}


