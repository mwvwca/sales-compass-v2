import type { RiskFlagKind } from '@/lib/dealRisk';

// Shared risk-flag + next-step-verdict chip rendering, so the deal-risk view, the
// rep scorecard, and the deal 360 all render the exact same labels, tones, and chips.

export const FLAG_META: Record<RiskFlagKind, { label: string; tone: string }> = {
  pushed: { label: 'Pushed', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  stalled: { label: 'Stalled', tone: 'bg-red-500/15 text-red-700 dark:text-red-400' },
  under_qualified: { label: 'Under-qualified', tone: 'bg-blue-500/15 text-blue-700 dark:text-blue-400' },
  no_next_step: { label: 'No next step', tone: 'bg-secondary/40 text-muted-foreground' },
  vague_next_step: { label: 'Vague next step', tone: 'bg-purple-500/15 text-purple-700 dark:text-purple-400' },
  single_threaded: { label: 'Single-threaded', tone: 'bg-secondary/40 text-muted-foreground' },
  negative_sentiment: { label: 'Negative sentiment', tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400' },
};

