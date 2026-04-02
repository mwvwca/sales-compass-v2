import type { Opportunity } from '@/types/forecast';

export type OpportunityClassification = Opportunity['classification'];

export function isTruthyForecastFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === 'yes' || normalized === 'y' || normalized === '1' || normalized === 'commit' || normalized === 'forecast';
}

export function isTruthyUpsideFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === 'yes' || normalized === 'y' || normalized === '1' || normalized === 'upside';
}

export function resolveImportedClassification(
  existingClassification: OpportunityClassification,
  incomingClassification: OpportunityClassification,
): OpportunityClassification {
  if (existingClassification === 'omitted') return 'omitted';
  if (incomingClassification === 'closed_won' || incomingClassification === 'lost') return incomingClassification;
  if (incomingClassification === 'commit' || incomingClassification === 'upside') return incomingClassification;
  return existingClassification;
}

