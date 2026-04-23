import type { Opportunity } from '@/types/forecast';

export type OpportunityClassification = Opportunity['classification'];

export function normalizeImportFlag(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

export function isTruthyForecastFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  const normalized = normalizeImportFlag(value);
  return normalized === 'true' || normalized === 'yes' || normalized === 'y' || normalized === '1' || normalized === 'commit' || normalized === 'forecast';
}

export function isTruthyUpsideFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  const normalized = normalizeImportFlag(value);
  return normalized === 'true' || normalized === 'yes' || normalized === 'y' || normalized === '1' || normalized === 'upside';
}

export function getImportedClassification(params: {
  stage?: unknown;
  forecastCategory?: unknown;
  forecastFlag?: unknown;
  upsideFlag?: unknown;
}): OpportunityClassification {
  const stageNorm = normalizeImportFlag(params.stage).replace(/[-_/]/g, ' ').replace(/\s+/g, ' ');
  if (stageNorm === 'closed won') return 'closed_won';
  if (stageNorm === 'closed lost') return 'lost';

  const categoryNorm = normalizeImportFlag(params.forecastCategory).replace(/[-_/]/g, ' ').replace(/\s+/g, ' ');
  if (categoryNorm === 'commit') return 'commit';
  if (categoryNorm === 'upside') return 'upside';
  if (categoryNorm === 'omitted') return 'omitted';

  if (isTruthyForecastFlag(params.forecastFlag)) return 'commit';
  if (isTruthyUpsideFlag(params.upsideFlag)) return 'upside';

  return 'unclassified';
}

export function resolveImportedClassification(
  existingClassification: OpportunityClassification,
  incomingClassification: OpportunityClassification,
): OpportunityClassification {
  if (existingClassification === 'omitted') return 'omitted';
  if (existingClassification === 'closed_won' && incomingClassification !== 'omitted') return 'closed_won';
  if (existingClassification === 'lost' && incomingClassification !== 'omitted') return 'lost';
  if (incomingClassification === 'closed_won' || incomingClassification === 'lost') return incomingClassification;
  if (incomingClassification === 'commit' || incomingClassification === 'upside') return incomingClassification;
  return existingClassification;
}


