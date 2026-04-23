import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import type {
  Rep,
  Opportunity,
  ImportRecord,
  ChangeLogEntry,
  OpportunitySnapshot,
  CommissionReviewsMap,
  CommissionSettingsMap,
  RepCommissionSettings,
} from '@/types/forecast';
import { resolveImportedClassification } from '@/lib/forecastClassification';
import { normalizeRepName } from '@/lib/repUtils';
import { getCommissionReviewKey } from '@/lib/commissionUtils';

const STORAGE_KEYS = {
  reps: 'forecast_reps',
  opportunities: 'forecast_opportunities',
  imports: 'forecast_imports',
  changelog: 'forecast_changelog',
  snapshots: 'forecast_snapshots',
  commissionSettings: 'forecast_commission_settings',
  commissionReviews: 'forecast_commission_reviews',
  commissionPinHash: 'forecast_commission_pin_hash',
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

const MAX_SNAPSHOTS = 5000;

function getStorageSizeKB(): number {
  let total = 0;
  for (const key of Object.values(STORAGE_KEYS)) {
    const item = localStorage.getItem(key);
    if (item) total += item.length * 2;
  }
  return Math.round(total / 1024);
}

function pruneSnapshots(snapshots: OpportunitySnapshot[], limit: number): OpportunitySnapshot[] {
  if (snapshots.length <= limit) return snapshots;

  const byOpp = new Map<string, OpportunitySnapshot[]>();
  for (const s of snapshots) {
    const arr = byOpp.get(s.opportunityId) || [];
    arr.push(s);
    byOpp.set(s.opportunityId, arr);
  }

  const pruned: OpportunitySnapshot[] = [];
  for (const arr of byOpp.values()) {
    arr.sort((a, b) => new Date(b.importDate).getTime() - new Date(a.importDate).getTime());
    pruned.push(...arr.slice(0, 3));
  }

  if (pruned.length > limit) {
    pruned.sort((a, b) => new Date(b.importDate).getTime() - new Date(a.importDate).getTime());
    return pruned.slice(0, limit);
  }

  return pruned;
}

function updateCommissionReviewRecord(
  reviews: CommissionReviewsMap,
  repName: string,
  monthKey: string,
  updater: (current: NonNullable<CommissionReviewsMap[string]>) => NonNullable<CommissionReviewsMap[string]> | null,
): CommissionReviewsMap {
  const repKey = normalizeRepName(repName);
  if (!repKey || !monthKey) return reviews;

  const reviewKey = getCommissionReviewKey(repKey, monthKey);
  const current = reviews[reviewKey] || {
    repKey,
    repName: repName.trim(),
    monthKey,
    actualTotal: undefined,
    opportunities: {},
  };

  const next = updater(current);
  if (!next) {
    const { [reviewKey]: _removed, ...remaining } = reviews;
    return remaining;
  }

  return {
    ...reviews,
    [reviewKey]: next,
  };
}

interface ForecastState {
  reps: Rep[];
  opportunities: Opportunity[];
  imports: ImportRecord[];
  changelog: ChangeLogEntry[];
  snapshots: OpportunitySnapshot[];
  commissionSettings: CommissionSettingsMap;
  commissionReviews: CommissionReviewsMap;
  commissionPinHash: string | null;
  loading: boolean;
}

interface ForecastContextValue extends ForecastState {
  addRep: (rep: Rep) => void;
  updateRep: (rep: Rep) => void;
  deleteRep: (id: string) => void;
  importOpportunities: (opps: Opportunity[], fileName: string) => void;
  classifyOpportunity: (id: string, classification: 'commit' | 'upside' | 'closed_won' | 'unclassified' | 'lost' | 'omitted') => void;
  archiveToGraveyard: (id: string, reason?: string) => void;
  restoreFromGraveyard: (id: string) => void;
  updateOpportunityAmount: (id: string, amount: number) => void;
  updateOpportunity: (id: string, updates: Partial<Omit<Opportunity, 'id'>>) => void;
  deleteOpportunity: (id: string) => void;
  clearChangelog: () => void;
  setCommissionSettings: (repName: string, settings: RepCommissionSettings) => void;
  clearCommissionSettings: (repName: string) => void;
  updateCommissionMonthActual: (repName: string, monthKey: string, actualTotal?: number) => void;
  updateCommissionOpportunityReview: (repName: string, monthKey: string, opportunityId: string, updates: { actualCommission?: number; note?: string }) => void;
  setCommissionPinHash: (pinHash: string | null) => void;
  restoreFromBackup: (data: {
    reps: Rep[];
    opportunities: Opportunity[];
    imports: ImportRecord[];
    changelog: ChangeLogEntry[];
    snapshots?: OpportunitySnapshot[];
    commissionSettings?: CommissionSettingsMap;
    commissionReviews?: CommissionReviewsMap;
    commissionPinHash?: string | null;
  }) => void;
  getOpportunityHistory: (opportunityId: string) => OpportunitySnapshot[];
}

type ForecastContextWindow = Window & typeof globalThis & {
  __forecastContextValue__?: ForecastContextValue;
};

function getWindowForecastContext(): ForecastContextValue | null {
  if (typeof window === 'undefined') return null;
  return (window as ForecastContextWindow).__forecastContextValue__ ?? null;
}

const ForecastContext = createContext<ForecastContextValue | null>(null);

export function ForecastProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ForecastState>(() => {
    const opportunities = loadFromStorage<Opportunity[]>(STORAGE_KEYS.opportunities, []);

    const migrated = opportunities.map(o => {
      const stageNorm = (o.stage || '').toLowerCase().trim().replace(/[-_/]/g, ' ').replace(/\s+/g, ' ');
      if (stageNorm === 'closed won' && o.classification !== 'closed_won') {
        return { ...o, previousClassification: o.classification, classification: 'closed_won' as const, movedAt: new Date().toISOString() };
      }
      if (stageNorm === 'closed lost' && o.classification !== 'lost') {
        return {
          ...o,
          previousClassification: o.classification,
          classification: 'lost' as const,
          lostDate: o.lostDate || new Date().toISOString(),
          lostReason: o.lostReason || 'Closed Lost in Salesforce',
          movedAt: new Date().toISOString(),
        };
      }
      return o;
    });

    return {
      reps: loadFromStorage(STORAGE_KEYS.reps, []),
      opportunities: migrated,
      imports: loadFromStorage(STORAGE_KEYS.imports, []),
      changelog: loadFromStorage(STORAGE_KEYS.changelog, []),
      snapshots: loadFromStorage(STORAGE_KEYS.snapshots, []),
      commissionSettings: loadFromStorage(STORAGE_KEYS.commissionSettings, {}),
      commissionReviews: loadFromStorage(STORAGE_KEYS.commissionReviews, {}),
      commissionPinHash: loadFromStorage<string | null>(STORAGE_KEYS.commissionPinHash, null),
      loading: false,
    };
  });

  useEffect(() => {
    const prunedSnapshots = pruneSnapshots(state.snapshots, MAX_SNAPSHOTS);
    if (prunedSnapshots.length !== state.snapshots.length) {
      setState(s => ({ ...s, snapshots: prunedSnapshots }));
      return;
    }

    saveToStorage(STORAGE_KEYS.reps, state.reps);
    saveToStorage(STORAGE_KEYS.opportunities, state.opportunities);
    saveToStorage(STORAGE_KEYS.imports, state.imports);
    saveToStorage(STORAGE_KEYS.changelog, state.changelog);
    saveToStorage(STORAGE_KEYS.snapshots, state.snapshots);
    saveToStorage(STORAGE_KEYS.commissionSettings, state.commissionSettings);
    saveToStorage(STORAGE_KEYS.commissionReviews, state.commissionReviews);
    saveToStorage(STORAGE_KEYS.commissionPinHash, state.commissionPinHash);

    const sizeKB = getStorageSizeKB();
    if (sizeKB > 4000) {
      console.warn(`[Forecast] localStorage usage: ${sizeKB}KB / ~5000KB. Consider exporting a backup.`);
    }
  }, [
    state.reps,
    state.opportunities,
    state.imports,
    state.changelog,
    state.snapshots,
    state.commissionSettings,
    state.commissionReviews,
    state.commissionPinHash,
  ]);

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

          const resolvedClassification = resolveImportedClassification(existing.classification, o.classification);

          return {
            ...o,
            notes: existing.notes,
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

  const classifyOpportunity = useCallback((id: string, classification: 'commit' | 'upside' | 'closed_won' | 'unclassified' | 'lost' | 'omitted') => {
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
        o.id === id ? { ...o, previousClassification: o.classification, classification: 'lost' as const, lostDate: new Date().toISOString(), lostReason: reason || 'Removed from import' } : o,
      ),
    }));
  }, []);

  const restoreFromGraveyard = useCallback((id: string) => {
    setState(s => ({
      ...s,
      opportunities: s.opportunities.map(o =>
        o.id === id ? { ...o, classification: (o.previousClassification && o.previousClassification !== 'lost' ? o.previousClassification : 'unclassified') as Opportunity['classification'], lostDate: undefined, lostReason: undefined } : o,
      ),
    }));
  }, []);

  const clearChangelog = useCallback(() => {
    setState(s => ({ ...s, changelog: [] }));
  }, []);

  const setCommissionSettings = useCallback((repName: string, settings: RepCommissionSettings) => {
    const repKey = normalizeRepName(repName);
    if (!repKey) return;

    setState(s => ({
      ...s,
      commissionSettings: {
        ...s.commissionSettings,
        [repKey]: {
          monthlyQuota: Math.max(0, settings.monthlyQuota || 0),
          baseRate: Math.max(0, settings.baseRate || 0),
        },
      },
    }));
  }, []);

  const clearCommissionSettings = useCallback((repName: string) => {
    const repKey = normalizeRepName(repName);
    if (!repKey) return;

    setState(s => {
      const { [repKey]: _removed, ...remaining } = s.commissionSettings;
      return { ...s, commissionSettings: remaining };
    });
  }, []);

  const updateCommissionMonthActual = useCallback((repName: string, monthKey: string, actualTotal?: number) => {
    setState(s => ({
      ...s,
      commissionReviews: updateCommissionReviewRecord(s.commissionReviews, repName, monthKey, current => {
        const nextActualTotal = actualTotal === undefined || Number.isNaN(actualTotal) ? undefined : Math.max(0, actualTotal);
        const hasOpportunityEntries = Object.keys(current.opportunities).length > 0;
        if (nextActualTotal === undefined && !hasOpportunityEntries) return null;
        return {
          ...current,
          actualTotal: nextActualTotal,
        };
      }),
    }));
  }, []);

  const updateCommissionOpportunityReview = useCallback((repName: string, monthKey: string, opportunityId: string, updates: { actualCommission?: number; note?: string }) => {
    setState(s => ({
      ...s,
      commissionReviews: updateCommissionReviewRecord(s.commissionReviews, repName, monthKey, current => {
        const sanitizedActual = updates.actualCommission === undefined || Number.isNaN(updates.actualCommission)
          ? undefined
          : Math.max(0, updates.actualCommission);
        const sanitizedNote = updates.note?.trim() ? updates.note.trim() : undefined;
        const nextOpportunity = {
          actualCommission: sanitizedActual,
          note: sanitizedNote,
        };
        const nextOpportunities = { ...current.opportunities };

        if (nextOpportunity.actualCommission === undefined && !nextOpportunity.note) {
          delete nextOpportunities[opportunityId];
        } else {
          nextOpportunities[opportunityId] = nextOpportunity;
        }

        const hasOpportunityEntries = Object.keys(nextOpportunities).length > 0;
        if (current.actualTotal === undefined && !hasOpportunityEntries) return null;

        return {
          ...current,
          opportunities: nextOpportunities,
        };
      }),
    }));
  }, []);

  const setCommissionPinHash = useCallback((pinHash: string | null) => {
    setState(s => ({ ...s, commissionPinHash: pinHash }));
  }, []);

  const restoreFromBackup = useCallback((data: {
    reps: Rep[];
    opportunities: Opportunity[];
    imports: ImportRecord[];
    changelog: ChangeLogEntry[];
    snapshots?: OpportunitySnapshot[];
    commissionSettings?: CommissionSettingsMap;
    commissionReviews?: CommissionReviewsMap;
    commissionPinHash?: string | null;
  }) => {
    setState(s => ({
      ...s,
      reps: data.reps,
      opportunities: data.opportunities,
      imports: data.imports,
      changelog: data.changelog,
      snapshots: data.snapshots || s.snapshots,
      commissionSettings: data.commissionSettings || {},
      commissionReviews: data.commissionReviews || {},
      commissionPinHash: data.commissionPinHash ?? null,
    }));
  }, []);

  const getOpportunityHistory = useCallback((opportunityId: string): OpportunitySnapshot[] => {
    return state.snapshots
      .filter(s => s.opportunityId === opportunityId)
      .sort((a, b) => new Date(a.importDate).getTime() - new Date(b.importDate).getTime());
  }, [state.snapshots]);

  const contextValue: ForecastContextValue = {
    ...state,
    addRep,
    updateRep,
    deleteRep,
    importOpportunities,
    classifyOpportunity,
    updateOpportunityAmount,
    updateOpportunity,
    deleteOpportunity,
    archiveToGraveyard,
    restoreFromGraveyard,
    clearChangelog,
    setCommissionSettings,
    clearCommissionSettings,
    updateCommissionMonthActual,
    updateCommissionOpportunityReview,
    setCommissionPinHash,
    restoreFromBackup,
    getOpportunityHistory,
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const win = window as ForecastContextWindow;
    win.__forecastContextValue__ = contextValue;
    return () => {
      if (win.__forecastContextValue__ === contextValue) {
        delete win.__forecastContextValue__;
      }
    };
  }, [contextValue]);

  return (
    <ForecastContext.Provider value={contextValue}>
      {children}
    </ForecastContext.Provider>
  );
}

export function useForecast() {
  const ctx = useContext(ForecastContext);
  if (ctx) return ctx;

  const fallbackCtx = getWindowForecastContext();
  if (fallbackCtx) return fallbackCtx;

  throw new Error('useForecast must be used within ForecastProvider');
}
