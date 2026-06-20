import type { DrStatus } from '@/types/forecast';

// Shared deal-registration status rendering, so the DR Pipeline tab and the deal
// 360 render the same labels and badge colors.

export const STATUS_CHIPS: { key: DrStatus; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'sql', label: 'SQL' },
  { key: 'stale', label: 'Stale' },
  { key: 'padded', label: 'Padded' },
  { key: 'converted', label: 'Converted' },
  { key: 'closed_won', label: 'Closed Won' },
  { key: 'closed_lost', label: 'Closed Lost' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'withdrawn', label: 'Withdrawn' },
];

export function statusBadgeCls(s: DrStatus): string {
  switch (s) {
    case 'sql': return 'bg-green-500/15 text-green-700 dark:text-green-400';
    case 'active': return 'bg-blue-500/15 text-blue-700 dark:text-blue-400';
    case 'stale': return 'bg-amber-500/15 text-amber-700 dark:text-amber-400';
    case 'padded': return 'bg-red-500/15 text-red-700 dark:text-red-400';
    case 'converted': return 'bg-teal-500/15 text-teal-700 dark:text-teal-400';
    case 'closed_won': return 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 font-semibold';
    case 'closed_lost': return 'bg-red-500/10 text-red-700/70 dark:text-red-400/70';
    case 'rejected': return 'bg-foreground/15 text-foreground/80';
    case 'withdrawn': return 'bg-muted text-muted-foreground';
  }
}

export function statusLabel(s: DrStatus): string {
  return STATUS_CHIPS.find(c => c.key === s)?.label || s;
}
