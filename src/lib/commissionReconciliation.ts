import type {
  CommissionReviewsMap,
  CommissionSettingsMap,
  Opportunity,
} from '@/types/forecast';
import { buildCommissionReview } from '@/lib/commissionUtils';
import { normalizeRepName } from '@/lib/repUtils';
import { findMatchingLine, type ParsedStatement } from '@/lib/commissionPdfParser';

export type ReconciliationStatus =
  | 'match'
  | 'overpaid'
  | 'underpaid'
  | 'missing_from_statement'
  | 'missing_from_app';

export interface ReconciliationLine {
  opportunityId?: string;
  opportunityName: string;
  repName: string;
  appCalculatedAmount: number;
  appCommissionDollars: number;
  statementAmount?: number;
  statementCommission?: number;
  statementRawLine?: string;
  matched: boolean;
  delta: number;
  status: ReconciliationStatus;
  deltaPercent: number;
}

export interface ReconciliationResult {
  repName: string;
  monthKey: string;
  lines: ReconciliationLine[];
  appTotal: number;
  statementTotal: number;
  totalDelta: number;
  matchedCount: number;
  missingFromStatement: number;
  missingFromApp: number;
  discrepancyCount: number;
}

const TOLERANCE = 1; // $1 tolerance for "match"

export function reconcileCommission(
  statement: ParsedStatement,
  opportunities: Opportunity[],
  commissionSettings: CommissionSettingsMap,
  commissionReviews: CommissionReviewsMap,
  repName: string,
  monthKey: string,
): ReconciliationResult {
  const repKey = normalizeRepName(repName);
  const review = buildCommissionReview(opportunities, commissionSettings, commissionReviews, monthKey, repKey, false);
  const appRows = review.selectedMonthRows.filter(r => r.repKey === repKey && r.monthKey === monthKey);

  const used = new Set<number>();
  const lines: ReconciliationLine[] = [];

  let appTotal = 0;
  let statementTotal = 0;
  let matchedCount = 0;
  let missingFromStatement = 0;
  let discrepancyCount = 0;

  for (const row of appRows) {
    appTotal += row.expectedCommission;
    const match = findMatchingLine(row.opportunityName, statement.lines, used);
    if (match) {
      used.add(match.idx);
      const stmtCommission = match.line.commissionAmount ?? 0;
      statementTotal += stmtCommission;
      const delta = stmtCommission - row.expectedCommission;
      const deltaPercent = row.expectedCommission > 0 ? delta / row.expectedCommission : 0;
      let status: ReconciliationStatus = 'match';
      if (Math.abs(delta) > TOLERANCE) {
        status = delta > 0 ? 'overpaid' : 'underpaid';
        discrepancyCount++;
      } else {
        matchedCount++;
      }
      lines.push({
        opportunityId: row.opportunityId,
        opportunityName: row.opportunityName,
        repName: row.repName,
        appCalculatedAmount: row.amount,
        appCommissionDollars: row.expectedCommission,
        statementAmount: match.line.amount,
        statementCommission: stmtCommission,
        statementRawLine: match.line.rawText,
        matched: true,
        delta,
        status,
        deltaPercent,
      });
    } else {
      missingFromStatement++;
      lines.push({
        opportunityId: row.opportunityId,
        opportunityName: row.opportunityName,
        repName: row.repName,
        appCalculatedAmount: row.amount,
        appCommissionDollars: row.expectedCommission,
        matched: false,
        delta: -row.expectedCommission,
        status: 'missing_from_statement',
        deltaPercent: -1,
      });
    }
  }

  // Unmatched PDF deal lines = missing from app
  let missingFromApp = 0;
  statement.lines.forEach((line, idx) => {
    if (used.has(idx)) return;
    if (line.lineType !== 'deal') return;
    const stmtCommission = line.commissionAmount ?? 0;
    statementTotal += stmtCommission;
    missingFromApp++;
    lines.push({
      opportunityName: line.opportunityName || line.rawText.slice(0, 60),
      repName,
      appCalculatedAmount: 0,
      appCommissionDollars: 0,
      statementAmount: line.amount,
      statementCommission: stmtCommission,
      statementRawLine: line.rawText,
      matched: false,
      delta: stmtCommission,
      status: 'missing_from_app',
      deltaPercent: 1,
    });
  });

  return {
    repName,
    monthKey,
    lines,
    appTotal,
    statementTotal,
    totalDelta: statementTotal - appTotal,
    matchedCount,
    missingFromStatement,
    missingFromApp,
    discrepancyCount,
  };
}
