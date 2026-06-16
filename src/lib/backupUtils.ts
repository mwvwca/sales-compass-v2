import type {
  Rep,
  Opportunity,
  ImportRecord,
  ChangeLogEntry,
  OpportunitySnapshot,
  MonthlyRepCommit,
  MonthlyManagerCommit,
  ForecastPromotion,
  ForecastSnapshot,
  ManagerQuota,
  CommissionSettingsMap,
  CommissionReviewsMap,
  WeeklySnapshot,
} from '@/types/forecast';

export interface BackupPayload {
  reps: Rep[];
  opportunities: Opportunity[];
  imports: ImportRecord[];
  changelog: ChangeLogEntry[];
  monthlyRepCommits: MonthlyRepCommit[];
  monthlyManagerCommits?: MonthlyManagerCommit[];
  forecastPromotions?: ForecastPromotion[];
  forecastSnapshots?: ForecastSnapshot[];
  commissionSettings: CommissionSettingsMap;
  commissionReviews: CommissionReviewsMap;
  commissionPinHash: string | null;
  snapshots?: OpportunitySnapshot[];
  managerQuotas?: ManagerQuota[];
  weeklySnapshots?: WeeklySnapshot[];
}

export function downloadBackupNow(data: BackupPayload, fileNamePrefix = 'forecast-backup'): void {
  const payload = { ...data, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileNamePrefix}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
