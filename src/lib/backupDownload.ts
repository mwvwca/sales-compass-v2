export interface BackupPayload {
  reps: unknown;
  opportunities: unknown;
  imports: unknown;
  changelog: unknown;
  snapshots?: unknown;
  commissionSettings?: unknown;
  commissionReviews?: unknown;
  commissionPinHash?: unknown;
  monthlyCommits?: unknown;
  annualStretchGoals?: unknown;
  exportedAt?: string;
}

export function downloadBackup(data: BackupPayload, fileNamePrefix = 'forecast-backup') {
  const payload = { ...data, exportedAt: data.exportedAt ?? new Date().toISOString() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileNamePrefix}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
