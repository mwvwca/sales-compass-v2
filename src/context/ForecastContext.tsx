import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import type { Rep, Opportunity, ImportRecord, ChangeLogEntry } from '@/types/forecast';

const STORAGE_KEYS = {
  reps: 'forecast_reps',
  opportunities: 'forecast_opportunities',
  imports: 'forecast_imports',
  changelog: 'forecast_changelog',
};

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveToStorage<T>(key: string, data: T) {
  localStorage.setItem(key, JSON.stringify(data));
}

interface ForecastState {
  reps: Rep[];
  opportunities: Opportunity[];
  imports: ImportRecord[];
  changelog: ChangeLogEntry[];
  loading: boolean;
}

interface ForecastContextValue extends ForecastState {
  addRep: (rep: Rep) => void;
  updateRep: (rep: Rep) => void;
  deleteRep: (id: string) => void;
  importOpportunities: (opps: Opportunity[], fileName: string) => void;
  classifyOpportunity: (id: string, classification: 'commit' | 'upside' | 'closed_won' | 'unclassified') => void;
  updateOpportunityAmount: (id: string, amount: number) => void;
  updateOpportunity: (id: string, updates: Partial<Omit<Opportunity, 'id'>>) => void;
  deleteOpportunity: (id: string) => void;
  clearChangelog: () => void;
  restoreFromBackup: (data: { reps: Rep[]; opportunities: Opportunity[]; imports: ImportRecord[]; changelog: ChangeLogEntry[] }) => void;
}

const ForecastContext = createContext<ForecastContextValue | null>(null);

export function ForecastProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ForecastState>({
    reps: loadFromStorage(STORAGE_KEYS.reps, []),
    opportunities: loadFromStorage(STORAGE_KEYS.opportunities, []),
    imports: loadFromStorage(STORAGE_KEYS.imports, []),
    changelog: loadFromStorage(STORAGE_KEYS.changelog, []),
    loading: false,
  });

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.reps, state.reps);
    saveToStorage(STORAGE_KEYS.opportunities, state.opportunities);
    saveToStorage(STORAGE_KEYS.imports, state.imports);
    saveToStorage(STORAGE_KEYS.changelog, state.changelog);
  }, [state.reps, state.opportunities, state.imports, state.changelog]);

  const addRep = useCallback((rep: Rep) => {
    setState(s => ({ ...s, reps: [...s.reps, rep] }));
  }, []);

  const updateRep = useCallback((rep: Rep) => {
    setState(s => ({ ...s, reps: s.reps.map(r => r.id === rep.id ? rep : r) }));
  }, []);

  const deleteRep = useCallback((id: string) => {
    setState(s => ({ ...s, reps: s.reps.filter(r => r.id !== id) }));
  }, []);

  const importOpportunities = useCallback((opps: Opportunity[], fileName: string) => {
    const importId = crypto.randomUUID();
    const importDate = new Date().toISOString();
    const record: ImportRecord = { id: importId, date: importDate, fileName, opportunityCount: opps.length };

    setState(s => {
      const existingMap = new Map(s.opportunities.map(o => [o.id, o]));
      const newChanges: ChangeLogEntry[] = [];

      const merged = opps.map(o => {
        const existing = existingMap.get(o.id);
        if (existing) {
          // Log close date changes
          if (existing.closeDate !== o.closeDate) {
            newChanges.push({
              id: crypto.randomUUID(),
              importDate,
              fileName,
              opportunityId: o.id,
              opportunityName: o.name,
              repName: o.repName,
              field: 'closeDate',
              oldValue: existing.closeDate || '(empty)',
              newValue: o.closeDate || '(empty)',
            });
          }
          // Log amount changes
          if (existing.amount !== o.amount) {
            newChanges.push({
              id: crypto.randomUUID(),
              importDate,
              fileName,
              opportunityId: o.id,
              opportunityName: o.name,
              repName: o.repName,
              field: 'amount',
              oldValue: String(existing.amount),
              newValue: String(o.amount),
            });
          }
          return { ...o, classification: existing.classification, previousClassification: existing.previousClassification, movedAt: existing.movedAt };
        }
        return o;
      });

      const importedIds = new Set(opps.map(o => o.id));
      const kept = s.opportunities.filter(o => !importedIds.has(o.id));
      return {
        ...s,
        opportunities: [...kept, ...merged],
        imports: [...s.imports, record],
        changelog: [...s.changelog, ...newChanges],
      };
    });
  }, []);

  const classifyOpportunity = useCallback((id: string, classification: 'commit' | 'upside' | 'closed_won' | 'unclassified') => {
    setState(s => ({
      ...s,
      opportunities: s.opportunities.map(o => {
        if (o.id === id) {
          return { ...o, previousClassification: o.classification, classification, movedAt: new Date().toISOString() };
        }
        return o;
      }),
    }));
  }, []);

  const updateOpportunityAmount = useCallback((id: string, amount: number) => {
    setState(s => ({ ...s, opportunities: s.opportunities.map(o => o.id === id ? { ...o, amount } : o) }));
  }, []);

  const updateOpportunity = useCallback((id: string, updates: Partial<Omit<Opportunity, 'id'>>) => {
    setState(s => ({ ...s, opportunities: s.opportunities.map(o => o.id === id ? { ...o, ...updates } : o) }));
  }, []);

  const deleteOpportunity = useCallback((id: string) => {
    setState(s => ({ ...s, opportunities: s.opportunities.filter(o => o.id !== id) }));
  }, []);

  const clearChangelog = useCallback(() => {
    setState(s => ({ ...s, changelog: [] }));
  }, []);

  const restoreFromBackup = useCallback((data: { reps: Rep[]; opportunities: Opportunity[]; imports: ImportRecord[]; changelog: ChangeLogEntry[] }) => {
    setState(s => ({ ...s, reps: data.reps, opportunities: data.opportunities, imports: data.imports, changelog: data.changelog }));
  }, []);

  return (
    <ForecastContext.Provider value={{ ...state, addRep, updateRep, deleteRep, importOpportunities, classifyOpportunity, updateOpportunityAmount, updateOpportunity, deleteOpportunity, clearChangelog, restoreFromBackup }}>
      {children}
    </ForecastContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useForecast() {
  const ctx = useContext(ForecastContext);
  if (!ctx) throw new Error('useForecast must be used within ForecastProvider');
  return ctx;
}
