import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import type { Rep, Opportunity, ImportRecord, ChangeLogEntry, OpportunitySnapshot } from '@/types/forecast';

const STORAGE_KEYS = {
  reps: 'forecast_reps',
  opportunities: 'forecast_opportunities',
  imports: 'forecast_imports',
  changelog: 'forecast_changelog',
  snapshots: 'forecast_snapshots',
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

const MAX_SNAPSHOTS = 5000; // Cap snapshots to prevent localStorage overflow

function getStorageSizeKB(): number {
  let total = 0;
  for (const key of Object.values(STORAGE_KEYS)) {
    const item = localStorage.getItem(key);
    if (item) total += item.length * 2; // UTF-16 = 2 bytes per char
  }
  return Math.round(total / 1024);
}

function pruneSnapshots(snapshots: OpportunitySnapshot[], limit: number): OpportunitySnapshot[] {
  if (snapshots.length <= limit) return snapshots;
  // Keep the most recent snapshots per opportunity (latest import wins)
  const byOpp = new Map<string, OpportunitySnapshot[]>();
  for (const s of snapshots) {
    const arr = byOpp.get(s.opportunityId) || [];
    arr.push(s);
    byOpp.set(s.opportunityId, arr);
  }
  // Sort each group by date desc, keep last 3 per opp
  const pruned: OpportunitySnapshot[] = [];
  for (const arr of byOpp.values()) {
    arr.sort((a, b) => new Date(b.importDate).getTime() - new Date(a.importDate).getTime());
    pruned.push(...arr.slice(0, 3));
  }
  // If still over limit, keep most recent overall
  if (pruned.length > limit) {
    pruned.sort((a, b) => new Date(b.importDate).getTime() - new Date(a.importDate).getTime());
    return pruned.slice(0, limit);
  }
  return pruned;
}

/** Normalize a rep name for matching purposes */
export function normalizeRepName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

interface ForecastState {
  reps: Rep[];
  opportunities: Opportunity[];
  imports: ImportRecord[];
  changelog: ChangeLogEntry[];
  snapshots: OpportunitySnapshot[];
  loading: boolean;
}

interface ForecastContextValue extends ForecastState {
  addRep: (rep: Rep) => void;
  updateRep: (rep: Rep) => void;
  deleteRep: (id: string) => void;
  importOpportunities: (opps: Opportunity[], fileName: string) => void;
  classifyOpportunity: (id: string, classification: 'commit' | 'upside' | 'closed_won' | 'unclassified' | 'lost') => void;
  archiveToGraveyard: (id: string, reason?: string) => void;
  restoreFromGraveyard: (id: string) => void;
  updateOpportunityAmount: (id: string, amount: number) => void;
  updateOpportunity: (id: string, updates: Partial<Omit<Opportunity, 'id'>>) => void;
  deleteOpportunity: (id: string) => void;
  clearChangelog: () => void;
  restoreFromBackup: (data: { reps: Rep[]; opportunities: Opportunity[]; imports: ImportRecord[]; changelog: ChangeLogEntry[]; snapshots?: OpportunitySnapshot[] }) => void;
  getOpportunityHistory: (opportunityId: string) => OpportunitySnapshot[];
}

const ForecastContext = createContext<ForecastContextValue | null>(null);

export function ForecastProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ForecastState>(() => {
    const opportunities = loadFromStorage<Opportunity[]>(STORAGE_KEYS.opportunities, []);
    
    // One-time migration: fix classification for opps where stage is Closed Won/Lost but classification doesn't match
    const migrated = opportunities.map(o => {
      const stageNorm = (o.stage || '').toLowerCase().trim().replace(/[-_/]/g, ' ').replace(/\s+/g, ' ');
      if (stageNorm === 'closed won' && o.classification !== 'closed_won') {
        return { ...o, previousClassification: o.classification, classification: 'closed_won' as const, movedAt: new Date().toISOString() };
      }
      if (stageNorm === 'closed lost' && o.classification !== 'lost') {
        return { ...o, previousClassification: o.classification, classification: 'lost' as const, lostDate: o.lostDate || new Date().toISOString(), lostReason: o.lostReason || 'Closed Lost in Salesforce', movedAt: new Date().toISOString() };
      }
      return o;
    });

    return {
      reps: loadFromStorage(STORAGE_KEYS.reps, []),
      opportunities: migrated,
      imports: loadFromStorage(STORAGE_KEYS.imports, []),
      changelog: loadFromStorage(STORAGE_KEYS.changelog, []),
      snapshots: loadFromStorage(STORAGE_KEYS.snapshots, []),
      loading: false,
    };
  });

  useEffect(() => {
    // Prune snapshots before saving to prevent localStorage overflow
    const prunedSnapshots = pruneSnapshots(state.snapshots, MAX_SNAPSHOTS);
    if (prunedSnapshots.length !== state.snapshots.length) {
      setState(s => ({ ...s, snapshots: prunedSnapshots }));
      return; // Will re-trigger this effect with pruned data
    }
    saveToStorage(STORAGE_KEYS.reps, state.reps);
    saveToStorage(STORAGE_KEYS.opportunities, state.opportunities);
    saveToStorage(STORAGE_KEYS.imports, state.imports);
    saveToStorage(STORAGE_KEYS.changelog, state.changelog);
    saveToStorage(STORAGE_KEYS.snapshots, state.snapshots);

    // Warn if approaching localStorage limits
    const sizeKB = getStorageSizeKB();
    if (sizeKB > 4000) {
      console.warn(`[Forecast] localStorage usage: ${sizeKB}KB / ~5000KB. Consider exporting a backup.`);
    }
  }, [state.reps, state.opportunities, state.imports, state.changelog, state.snapshots]);

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
      const newSnapshots: OpportunitySnapshot[] = [];

      const merged = opps.map(o => {
        const existing = existingMap.get(o.id);

        // Create snapshot for every imported opportunity
        newSnapshots.push({
          opportunityId: o.id,
          importDate,
          fileName,
          amount: o.amount,
          closeDate: o.closeDate,
          stage: o.stage,
          classification: existing ? existing.classification : o.classification,
          name: o.name,
          repName: o.repName,
        });

        if (existing) {
          // Track all field changes
          const fieldsToTrack: { field: ChangeLogEntry['field']; oldVal: string; newVal: string }[] = [
            { field: 'closeDate', oldVal: existing.closeDate || '(empty)', newVal: o.closeDate || '(empty)' },
            { field: 'amount', oldVal: String(existing.amount), newVal: String(o.amount) },
            { field: 'stage', oldVal: existing.stage, newVal: o.stage },
            { field: 'name', oldVal: existing.name, newVal: o.name },
            { field: 'repName', oldVal: existing.repName, newVal: o.repName },
          ];

          for (const { field, oldVal, newVal } of fieldsToTrack) {
            if (oldVal !== newVal) {
              newChanges.push({
                id: crypto.randomUUID(),
                importDate,
                fileName,
                opportunityId: o.id,
                opportunityName: o.name,
                repName: o.repName,
                field,
                oldValue: oldVal,
                newValue: newVal,
              });
            }
          }

          // Stage-derived terminal classifications (closed_won / lost) override existing
          const resolvedClassification =
            (o.classification === 'closed_won' || o.classification === 'lost')
              ? o.classification
              : existing.classification;

          return {
            ...o,
            classification: resolvedClassification,
            previousClassification: existing.classification !== resolvedClassification ? existing.classification : existing.previousClassification,
            movedAt: existing.classification !== resolvedClassification ? new Date().toISOString() : existing.movedAt,
          };
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
        snapshots: [...s.snapshots, ...newSnapshots],
      };
    });
  }, []);

  const classifyOpportunity = useCallback((id: string, classification: 'commit' | 'upside' | 'closed_won' | 'unclassified' | 'lost') => {
    setState(s => {
      const opp = s.opportunities.find(o => o.id === id);
      const newChanges: ChangeLogEntry[] = [];

      if (opp && opp.classification !== classification) {
        newChanges.push({
          id: crypto.randomUUID(),
          importDate: new Date().toISOString(),
          fileName: '(manual)',
          opportunityId: id,
          opportunityName: opp.name,
          repName: opp.repName,
          field: 'classification',
          oldValue: opp.classification,
          newValue: classification,
        });
      }

      return {
        ...s,
        opportunities: s.opportunities.map(o => {
          if (o.id === id) {
            return { ...o, previousClassification: o.classification, classification, movedAt: new Date().toISOString() };
          }
          return o;
        }),
        changelog: [...s.changelog, ...newChanges],
      };
    });
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

  const archiveToGraveyard = useCallback((id: string, reason?: string) => {
    setState(s => ({
      ...s,
      opportunities: s.opportunities.map(o =>
        o.id === id ? { ...o, previousClassification: o.classification, classification: 'lost' as const, lostDate: new Date().toISOString(), lostReason: reason || 'Removed from import' } : o
      ),
    }));
  }, []);

  const restoreFromGraveyard = useCallback((id: string) => {
    setState(s => ({
      ...s,
      opportunities: s.opportunities.map(o =>
        o.id === id ? { ...o, classification: (o.previousClassification && o.previousClassification !== 'lost' ? o.previousClassification : 'unclassified') as any, lostDate: undefined, lostReason: undefined } : o
      ),
    }));
  }, []);

  const clearChangelog = useCallback(() => {
    setState(s => ({ ...s, changelog: [] }));
  }, []);

  const restoreFromBackup = useCallback((data: { reps: Rep[]; opportunities: Opportunity[]; imports: ImportRecord[]; changelog: ChangeLogEntry[]; snapshots?: OpportunitySnapshot[] }) => {
    setState(s => ({ ...s, reps: data.reps, opportunities: data.opportunities, imports: data.imports, changelog: data.changelog, snapshots: data.snapshots || s.snapshots }));
  }, []);

  const getOpportunityHistory = useCallback((opportunityId: string): OpportunitySnapshot[] => {
    return state.snapshots
      .filter(s => s.opportunityId === opportunityId)
      .sort((a, b) => new Date(a.importDate).getTime() - new Date(b.importDate).getTime());
  }, [state.snapshots]);

  return (
    <ForecastContext.Provider value={{ ...state, addRep, updateRep, deleteRep, importOpportunities, classifyOpportunity, updateOpportunityAmount, updateOpportunity, deleteOpportunity, archiveToGraveyard, restoreFromGraveyard, clearChangelog, restoreFromBackup, getOpportunityHistory }}>
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
