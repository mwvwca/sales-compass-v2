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
  WeeklySnapshot,
  DealRegistration,
  DrBatch,
} from '@/types/forecast';
import type { Transcript, TranscriptSignals } from '@/lib/transcripts';

export interface BackupPayload {
  reps: Rep[];
  opportunities: Opportunity[];
  imports: ImportRecord[];
  changelog: ChangeLogEntry[];
  monthlyRepCommits: MonthlyRepCommit[];
  monthlyManagerCommits?: MonthlyManagerCommit[];
  forecastPromotions?: ForecastPromotion[];
  forecastSnapshots?: ForecastSnapshot[];
  snapshots?: OpportunitySnapshot[];
  managerQuotas?: ManagerQuota[];
  weeklySnapshots?: WeeklySnapshot[];
  dealRegistrations: DealRegistration[];
  drBatches: DrBatch[];
  /** Latest extracted signals per opportunity (sourced from the transcripts table). */
  signals?: Record<string, TranscriptSignals>;
  /** Full call transcripts so the coaching picture is reconstructable from a backup. */
  transcripts?: Transcript[];
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
