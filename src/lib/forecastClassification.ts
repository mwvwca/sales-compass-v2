import type { Opportunity } from '@/types/forecast';

export type OpportunityClassification = Opportunity['classification'];

export function resolveImportedClassification(
  existingClassification: OpportunityClassification,
  incomingClassification: OpportunityClassification,
): OpportunityClassification {
  if (existingClassification === 'omitted') return 'omitted';
  if (incomingClassification === 'closed_won' || incomingClassification === 'lost') return incomingClassification;
  if (incomingClassification === 'commit' || incomingClassification === 'upside') return incomingClassification;
  return existingClassification;
}
