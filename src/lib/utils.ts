import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const STAGE_PERCENTAGES: Record<string, number> = {
  'qualified': 5,
  'discovery': 25,
  'technical': 50,
  'commercial': 75,
  'purchasing': 90,
  'submitted': 100,
  'closed won': 100,
  'closed lost': 0,
};

/** Get the percentage for a Salesforce stage name, or null if unknown. */
export function getStagePercentage(stage: string): number | null {
  const norm = stage.toLowerCase().trim().replace(/[-_/]/g, ' ').replace(/\s+/g, ' ');
  if (STAGE_PERCENTAGES[norm] !== undefined) return STAGE_PERCENTAGES[norm];
  for (const [key, pct] of Object.entries(STAGE_PERCENTAGES)) {
    if (norm.startsWith(key)) return pct;
  }
  return null;
}

/** Format stage with percentage, e.g. "Discovery (25%)" */
export function formatStageWithPct(stage: string): string {
  const pct = getStagePercentage(stage);
  return pct !== null ? `${stage} (${pct}%)` : stage;
}
