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
  MonthlyRepCommit,
  MonthlyManagerCommit,
  ManagerQuota,
  ForecastPromotion,
  ForecastSnapshot,
  ForecastDealLine,
  ForecastSnapshotOutcomeLine,
  DealRegistration,
  DrBatch,
  RawDrRecord,
  WeeklySnapshot,
} from '@/types/forecast';
import { getMonthKey, getWeeksInMonth, getDateAtUtcStart, getCurrentQuarter, quarterStart, quarterEnd } from '@/types/forecast';
import { mergeDrBatch } from '@/lib/drMerge';
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
  monthlyRepCommits: 'forecast_monthly_rep_commits',
  monthlyManagerCommits: 'forecast_monthly_manager_commits',
  forecastPromotions: 'forecast_promotions',
  forecastSnapshots: 'forecast_forecast_snapshots',
  dealRegistrations: 'forecast_deal_registrations',
  drBatches: 'forecast_dr_batches',
  managerQuotas: 'forecast_manager_quotas',
  weeklySnapshots: 'forecast_weekly_snapshots',
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
  monthlyRepCommits: MonthlyRepCommit[];
  monthlyManagerCommits: MonthlyManagerCommit[];
  forecastPromotions: ForecastPromotion[];
  forecastSnapshots: ForecastSnapshot[];
  dealRegistrations: DealRegistration[];
  drBatches: DrBatch[];
  managerQuotas: ManagerQuota[];
  weeklySnapshots: WeeklySnapshot[];


  loading: boolean;
}

interface ForecastContextValue extends ForecastState {
  addRep: (rep: Rep) => void;
  updateRep: (rep: Rep) => void;
  deleteRep: (id: string) => void;
  setRepActiveStatus: (repId: string, isActive: boolean, note?: string) => void;
  importOpportunities: (opps: Opportunity[], fileName: string) => void;
  classifyOpportunity: (id: string, classification: 'commit' | 'upside' | 'closed_won' | 'unclassified' | 'lost' | 'omitted' | 'rejected') => void;
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
  updateOpportunityCommissionDetails: (id: string, updates: Pick<Opportunity, 'commissionMrr' | 'commissionTermYears' | 'commissionPaymentType' | 'commissionSpiff' | 'commissionNotes'>) => void;
  setCommissionPinHash: (pinHash: string | null) => void;
  setMonthlyRepCommit: (repId: string, repName: string, monthKey: string, amount: number, notes?: string) => void;
  getMonthlyRepCommit: (repId: string, monthKey: string) => MonthlyRepCommit | undefined;
  getMonthlyCommitsByMonth: (monthKey: string) => MonthlyRepCommit[];
  setMonthlyManagerCommit: (monthKey: string, amount: number) => void;
  getMonthlyManagerCommit: (monthKey: string) => MonthlyManagerCommit | undefined;
  promoteOpportunityForecast: (opportunityId: string, monthKey: string) => void;
  demoteOpportunityForecast: (opportunityId: string, monthKey: string) => void;
  isOpportunityPromoted: (opportunityId: string, monthKey: string) => boolean;
  createForecastSnapshot: (monthKey: string) => ForecastSnapshot;
  reconcileForecastSnapshot: (snapshotId: string) => void;
  deleteForecastSnapshot: (snapshotId: string) => void;
  importDrBatch: (
    incoming: RawDrRecord[],
    batchMeta: { fileName: string; asOfDate: string; importedAt: string },
  ) => void;
  clearDrData: () => void;
  setManagerQuota: (year: number, amount: number, notes?: string) => void;
  getManagerQuota: (year: number) => ManagerQuota | undefined;
  restoreFromBackup: (data: {
    reps: Rep[];
    opportunities: Opportunity[];
    imports: ImportRecord[];
    changelog: ChangeLogEntry[];
    snapshots?: OpportunitySnapshot[];
    commissionSettings?: CommissionSettingsMap;
    commissionReviews?: CommissionReviewsMap;
    commissionPinHash?: string | null;
    monthlyRepCommits?: MonthlyRepCommit[];
    monthlyManagerCommits?: MonthlyManagerCommit[];
    forecastPromotions?: ForecastPromotion[];
    forecastSnapshots?: ForecastSnapshot[];
    dealRegistrations?: DealRegistration[];
    drBatches?: DrBatch[];
    managerQuotas?: ManagerQuota[];
    weeklySnapshots?: WeeklySnapshot[];
  }) => void;
  captureWeeklySnapshot: () => WeeklySnapshot;


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
    const sfIdPattern = /^006[A-Za-z0-9]{12,15}$/;

    const rawOpps = loadFromStorage<Opportunity[]>(STORAGE_KEYS.opportunities, []);
    // One-time cleanup: purge corrupted Salesforce footer rows ("Total", "Confidential", copyright)
    // that lack a valid Salesforce Opportunity ID.
    const cleanedOpps = rawOpps.filter((o: any) =>
      sfIdPattern.test(o.salesforceId || '') || sfIdPattern.test(o.id || '')
    );
    if (cleanedOpps.length !== rawOpps.length) {
      try { localStorage.setItem(STORAGE_KEYS.opportunities, JSON.stringify(cleanedOpps)); } catch { /* noop */ }
    }
    // Backward-compat: ensure salesforceId field exists on every record.
    // Legacy records used the Salesforce Opportunity ID as their internal `id`,
    // so use that as the salesforceId fallback. New imports populate it explicitly.
    const opportunities = cleanedOpps.map((o: any) => ({
      ...o,
      salesforceId: o.salesforceId ?? (typeof o.id === 'string' && /^[0-9a-zA-Z]{15,18}$/.test(o.id) ? o.id : undefined),
    })) as Opportunity[];

    const rawChangelog = loadFromStorage<any[]>(STORAGE_KEYS.changelog, []);
    const cleanedChangelog = rawChangelog.filter(e => sfIdPattern.test(e?.opportunityId || ''));
    if (cleanedChangelog.length !== rawChangelog.length) {
      try { localStorage.setItem(STORAGE_KEYS.changelog, JSON.stringify(cleanedChangelog)); } catch { /* noop */ }
    }

    const rawSnapshots = loadFromStorage<OpportunitySnapshot[]>(STORAGE_KEYS.snapshots, []);
    const cleanedSnapshots = rawSnapshots.filter(s => sfIdPattern.test(s?.opportunityId || ''));
    if (cleanedSnapshots.length !== rawSnapshots.length) {
      try { localStorage.setItem(STORAGE_KEYS.snapshots, JSON.stringify(cleanedSnapshots)); } catch { /* noop */ }
    }


    const migrated = opportunities.map(o => {
      const stageNorm = (o.stage || '').toLowerCase().trim().replace(/[-_/]/g, ' ').replace(/\s+/g, ' ');
      const terminal = o.classification === 'closed_won' || o.classification === 'omitted' || o.classification === 'lost' || o.classification === 'rejected';
      if (stageNorm === 'closed won' && !terminal) {
        return { ...o, previousClassification: o.classification, classification: 'closed_won' as const, movedAt: new Date().toISOString() };
      }
      if (stageNorm === 'closed lost' && o.classification !== 'lost' && o.classification !== 'omitted' && o.classification !== 'closed_won' && o.classification !== 'rejected') {
        return {
          ...o,
          previousClassification: o.classification,
          classification: 'lost' as const,
          lostDate: o.lostDate || new Date().toISOString(),
          lostReason: o.lostReason || 'Closed Lost in Salesforce',
          movedAt: new Date().toISOString(),
        };
      }
      if (stageNorm === 'rejected' && o.classification !== 'rejected' && o.classification !== 'omitted' && o.classification !== 'closed_won' && o.classification !== 'lost') {
        return {
          ...o,
          previousClassification: o.classification,
          classification: 'rejected' as const,
          lostDate: o.lostDate || new Date().toISOString(),
          lostReason: o.lostReason || 'Rejected in Salesforce',
          movedAt: new Date().toISOString(),
        };
      }
      return o;
    });

    return {
      reps: loadFromStorage<Rep[]>(STORAGE_KEYS.reps, []).map((r: any) => ({
        ...r,
        isActive: r.isActive === undefined ? true : !!r.isActive,
      })),
      opportunities: migrated,
      imports: loadFromStorage(STORAGE_KEYS.imports, []),
      changelog: cleanedChangelog,
      snapshots: cleanedSnapshots,
      commissionSettings: loadFromStorage(STORAGE_KEYS.commissionSettings, {}),
      commissionReviews: loadFromStorage(STORAGE_KEYS.commissionReviews, {}),
      commissionPinHash: loadFromStorage<string | null>(STORAGE_KEYS.commissionPinHash, null),
      monthlyRepCommits: loadFromStorage<MonthlyRepCommit[]>(STORAGE_KEYS.monthlyRepCommits, []),
      monthlyManagerCommits: loadFromStorage<MonthlyManagerCommit[]>(STORAGE_KEYS.monthlyManagerCommits, []),
      forecastPromotions: loadFromStorage<ForecastPromotion[]>(STORAGE_KEYS.forecastPromotions, []),
      forecastSnapshots: loadFromStorage<ForecastSnapshot[]>(STORAGE_KEYS.forecastSnapshots, []),
      dealRegistrations: loadFromStorage<DealRegistration[]>(STORAGE_KEYS.dealRegistrations, []).map((dr: any) => ({
        ...dr,
        stageHistory: dr.stageHistory ?? [],
      })),
      drBatches: loadFromStorage<DrBatch[]>(STORAGE_KEYS.drBatches, []),
      managerQuotas: loadFromStorage<ManagerQuota[]>(STORAGE_KEYS.managerQuotas, []),
      weeklySnapshots: loadFromStorage<WeeklySnapshot[]>(STORAGE_KEYS.weeklySnapshots, []),


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
    saveToStorage(STORAGE_KEYS.monthlyRepCommits, state.monthlyRepCommits);
    saveToStorage(STORAGE_KEYS.monthlyManagerCommits, state.monthlyManagerCommits);
    saveToStorage(STORAGE_KEYS.forecastPromotions, state.forecastPromotions);
    saveToStorage(STORAGE_KEYS.forecastSnapshots, state.forecastSnapshots);
    saveToStorage(STORAGE_KEYS.dealRegistrations, state.dealRegistrations);
    saveToStorage(STORAGE_KEYS.drBatches, state.drBatches);
    saveToStorage(STORAGE_KEYS.managerQuotas, state.managerQuotas);
    saveToStorage(STORAGE_KEYS.weeklySnapshots, state.weeklySnapshots);


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
    state.monthlyRepCommits,
    state.monthlyManagerCommits,
    state.forecastPromotions,
    state.forecastSnapshots,
    state.dealRegistrations,
    state.drBatches,
    state.managerQuotas,
    state.weeklySnapshots,
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

  const setRepActiveStatus = useCallback((repId: string, isActive: boolean, note?: string) => {
    setState(s => ({
      ...s,
      reps: s.reps.map(r => {
        if (r.id !== repId) return r;
        if (isActive) {
          return { ...r, isActive: true, inactivatedAt: undefined, inactivatedNote: undefined };
        }
        return {
          ...r,
          isActive: false,
          inactivatedAt: new Date().toISOString(),
          inactivatedNote: note?.trim() ? note.trim() : undefined,
        };
      }),
    }));
  }, []);

  const importOpportunities = useCallback((opps: Opportunity[], fileName: string) => {
    const importId = crypto.randomUUID();
    const importDate = new Date().toISOString();
    const record: ImportRecord = { id: importId, date: importDate, fileName, opportunityCount: opps.length };

    setState(s => {
      const existingBySfId = new Map<string, Opportunity>();
      const existingById = new Map<string, Opportunity>();
      for (const o of s.opportunities) {
        if (o.salesforceId) existingBySfId.set(o.salesforceId, o);
        existingById.set(o.id, o);
      }
      const newChanges: ChangeLogEntry[] = [];
      const newSnapshots: OpportunitySnapshot[] = [];
      const processedExistingIds = new Set<string>();

      const merged = opps.map(o => {
        const sfid = o.salesforceId;
        const existing =
          (sfid && existingBySfId.get(sfid)) ||
          existingById.get(o.id) ||
          (sfid && existingById.get(sfid)) ||
          undefined;

        // Preserve internal UUID for existing records; mint a fresh UUID for truly new ones.
        const stableId = existing ? existing.id : crypto.randomUUID();
        if (existing) processedExistingIds.add(existing.id);

        newSnapshots.push({
          opportunityId: stableId,
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
                opportunityId: stableId,
                opportunityName: o.name,
                repName: o.repName,
                field,
                oldValue: oldVal,
                newValue: newVal,
              });
            }
          }

          const resolvedClassification = resolveImportedClassification(existing.classification, o.classification);

          // Full field replacement: every field from incoming Salesforce export overwrites
          // the stored record. Only app-generated fields not present in the export are preserved.
          return {
            ...o,
            id: stableId,
            salesforceId: sfid ?? existing.salesforceId,
            // Always-overwrite Salesforce fields (explicit for clarity and safety)
            closeDate: o.closeDate,
            stage: o.stage,
            amount: o.amount,
            accountName: o.accountName,
            productName: o.productName,
            channelAccountManager: o.channelAccountManager,
            probability: o.probability,
            name: o.name,
            repName: o.repName,
            lostDate: o.lostDate ?? existing.lostDate,
            lostReason: o.lostReason ?? existing.lostReason,
            // Preserved app-generated fields not present in Salesforce export
            importDate: existing.importDate,
            notes: existing.notes,
            commissionMrr: existing.commissionMrr,
            commissionTermYears: existing.commissionTermYears,
            commissionPaymentType: existing.commissionPaymentType,
            commissionSpiff: existing.commissionSpiff,
            commissionNotes: existing.commissionNotes,
            classification: resolvedClassification,
            previousClassification: existing.classification !== resolvedClassification ? existing.classification : existing.previousClassification,
            movedAt: existing.classification !== resolvedClassification ? new Date().toISOString() : existing.movedAt,
          };
        }

        return { ...o, id: stableId, salesforceId: sfid };
      });

      const kept = s.opportunities.filter(o => !processedExistingIds.has(o.id));
      return {
        ...s,
        opportunities: [...kept, ...merged],
        imports: [...s.imports, record],
        changelog: [...s.changelog, ...newChanges],
        snapshots: [...s.snapshots, ...newSnapshots],
      };
    });
  }, []);

  const classifyOpportunity = useCallback((id: string, classification: 'commit' | 'upside' | 'closed_won' | 'unclassified' | 'lost' | 'omitted' | 'rejected') => {
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
        o.id === id ? { ...o, classification: (o.previousClassification && o.previousClassification !== 'lost' && o.previousClassification !== 'rejected' ? o.previousClassification : 'unclassified') as Opportunity['classification'], lostDate: undefined, lostReason: undefined } : o,
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
          annualVariableComp: settings.annualVariableComp === undefined ? undefined : Math.max(0, settings.annualVariableComp || 0),
            priorQuarterPayout: settings.priorQuarterPayout === undefined ? undefined : Math.max(0, settings.priorQuarterPayout || 0),
          baseRate: settings.baseRate === undefined ? undefined : Math.max(0, settings.baseRate || 0),
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

  const updateOpportunityCommissionDetails = useCallback((id: string, updates: Pick<Opportunity, 'commissionMrr' | 'commissionTermYears' | 'commissionPaymentType' | 'commissionSpiff' | 'commissionNotes'>) => {
    setState(s => ({
      ...s,
      opportunities: s.opportunities.map(o => (o.id === id
        ? {
            ...o,
            commissionMrr: updates.commissionMrr,
            commissionTermYears: updates.commissionTermYears,
            commissionPaymentType: updates.commissionPaymentType,
            commissionSpiff: updates.commissionSpiff,
            commissionNotes: updates.commissionNotes,
          }
        : o)),
    }));
  }, []);

  const setCommissionPinHash = useCallback((pinHash: string | null) => {
    setState(s => ({ ...s, commissionPinHash: pinHash }));
  }, []);

  const setMonthlyRepCommit = useCallback((repId: string, repName: string, monthKey: string, amount: number, notes?: string) => {
    setState(s => {
      const now = new Date().toISOString();
      const existing = s.monthlyRepCommits.find(m => m.repId === repId && m.monthKey === monthKey);
      const trimmedNotes = notes?.trim() ? notes.trim() : undefined;
      const next: MonthlyRepCommit = existing
        ? { ...existing, repName, commitAmount: amount, notes: trimmedNotes, updatedAt: now }
        : { id: crypto.randomUUID(), repId, repName, monthKey, commitAmount: amount, notes: trimmedNotes, createdAt: now, updatedAt: now };
      return {
        ...s,
        monthlyRepCommits: existing
          ? s.monthlyRepCommits.map(m => (m.repId === repId && m.monthKey === monthKey ? next : m))
          : [...s.monthlyRepCommits, next],
      };
    });
  }, []);

  const getMonthlyRepCommit = useCallback((repId: string, monthKey: string) => {
    return state.monthlyRepCommits.find(m => m.repId === repId && m.monthKey === monthKey);
  }, [state.monthlyRepCommits]);

  const getMonthlyCommitsByMonth = useCallback((monthKey: string) => {
    return state.monthlyRepCommits.filter(m => m.monthKey === monthKey);
  }, [state.monthlyRepCommits]);

  const setMonthlyManagerCommit = useCallback((monthKey: string, amount: number) => {
    setState(s => {
      const now = new Date().toISOString();
      const existing = s.monthlyManagerCommits.find(m => m.monthKey === monthKey);
      const next: MonthlyManagerCommit = existing
        ? { ...existing, commitAmount: amount, updatedAt: now }
        : { id: crypto.randomUUID(), monthKey, commitAmount: amount, createdAt: now, updatedAt: now };
      return {
        ...s,
        monthlyManagerCommits: existing
          ? s.monthlyManagerCommits.map(m => (m.monthKey === monthKey ? next : m))
          : [...s.monthlyManagerCommits, next],
      };
    });
  }, []);

  const getMonthlyManagerCommit = useCallback((monthKey: string) => {
    return state.monthlyManagerCommits.find(m => m.monthKey === monthKey);
  }, [state.monthlyManagerCommits]);

  const promoteOpportunityForecast = useCallback((opportunityId: string, monthKey: string) => {
    setState(s => {
      if (s.forecastPromotions.some(p => p.opportunityId === opportunityId && p.monthKey === monthKey)) return s;
      return {
        ...s,
        forecastPromotions: [...s.forecastPromotions, { opportunityId, monthKey, promotedAt: new Date().toISOString() }],
      };
    });
  }, []);

  const demoteOpportunityForecast = useCallback((opportunityId: string, monthKey: string) => {
    setState(s => ({
      ...s,
      forecastPromotions: s.forecastPromotions.filter(p => !(p.opportunityId === opportunityId && p.monthKey === monthKey)),
    }));
  }, []);

  const isOpportunityPromoted = useCallback((opportunityId: string, monthKey: string) => {
    return state.forecastPromotions.some(p => p.opportunityId === opportunityId && p.monthKey === monthKey);
  }, [state.forecastPromotions]);

  const buildDealsForMonth = useCallback((monthKey: string): { deals: ForecastDealLine[]; commitTotal: number; promotedUpsideTotal: number } => {
    const weeks = getWeeksInMonth(monthKey);
    const activeRepNames = new Set(state.reps.filter(r => r.isActive !== false).map(r => r.name));
    const promotedSet = new Set(state.forecastPromotions.filter(p => p.monthKey === monthKey).map(p => p.opportunityId));
    const deals: ForecastDealLine[] = [];
    let commitTotal = 0;
    let promotedUpsideTotal = 0;
    for (const o of state.opportunities) {
      if (!o.closeDate) continue;
      if (getMonthKey(o.closeDate) !== monthKey) continue;
      const stageNorm = (o.stage || '').toLowerCase().trim();
      if (o.classification === 'lost' || o.classification === 'rejected' || o.classification === 'omitted') continue;
      if (stageNorm === 'closed lost' || stageNorm === 'rejected') continue;
      if (!activeRepNames.has(o.repName)) continue;
      const isCommit = o.classification === 'commit';
      const isPromoted = promotedSet.has(o.id) && o.classification === 'upside';
      if (!isCommit && !isPromoted) continue;
      const d = getDateAtUtcStart(o.closeDate);
      const w = weeks.find(w => d >= w.start && d <= w.end);
      deals.push({
        opportunityId: o.id,
        opportunityName: o.name,
        repName: o.repName,
        amount: o.amount,
        closeDate: o.closeDate,
        stage: o.stage,
        classification: isCommit ? 'commit' : 'promoted_upside',
        weekLabel: w?.label ?? '—',
      });
      if (isCommit) commitTotal += o.amount;
      else promotedUpsideTotal += o.amount;
    }
    return { deals, commitTotal, promotedUpsideTotal };
  }, [state.opportunities, state.reps, state.forecastPromotions]);

  const createForecastSnapshot = useCallback((monthKey: string): ForecastSnapshot => {
    const { deals, commitTotal, promotedUpsideTotal } = buildDealsForMonth(monthKey);
    const managerCommit = state.monthlyManagerCommits.find(m => m.monthKey === monthKey)?.commitAmount ?? 0;
    const repRollup = state.monthlyRepCommits.filter(m => m.monthKey === monthKey).reduce((s, m) => s + m.commitAmount, 0);
    const now = new Date();
    const monthLabelDate = new Date(`${monthKey}-01T00:00:00Z`);
    const monthLabel = monthLabelDate.toLocaleString('default', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const tsLabel = now.toLocaleString('default', { month: 'short', day: 'numeric' }) + ' at ' + now.toLocaleTimeString('default', { hour: 'numeric', minute: '2-digit' });
    const snapshot: ForecastSnapshot = {
      id: crypto.randomUUID(),
      monthKey,
      snapshotLabel: `${monthLabel} — ${tsLabel}`,
      createdAt: now.toISOString(),
      managerCommit,
      repRollup,
      commitTotal,
      promotedUpsideTotal,
      totalCall: commitTotal + promotedUpsideTotal,
      deals,
    };
    setState(s => ({ ...s, forecastSnapshots: [...s.forecastSnapshots, snapshot] }));
    return snapshot;
  }, [buildDealsForMonth, state.monthlyManagerCommits, state.monthlyRepCommits]);

  const reconcileForecastSnapshot = useCallback((snapshotId: string) => {
    setState(s => {
      const snap = s.forecastSnapshots.find(x => x.id === snapshotId);
      if (!snap) return s;
      const now = new Date();
      let closedWonTotal = 0;
      let closedWonCount = 0;
      const outcomes: ForecastSnapshotOutcomeLine[] = snap.deals.map(d => {
        const opp = s.opportunities.find(o => o.id === d.opportunityId);
        if (!opp) return { opportunityId: d.opportunityId, status: 'removed', amount: d.amount };
        const stageNorm = (opp.stage || '').toLowerCase().trim();
        if (opp.classification === 'closed_won' || stageNorm === 'closed won') {
          closedWonTotal += opp.amount;
          closedWonCount += 1;
          return { opportunityId: d.opportunityId, status: 'won', amount: opp.amount, closedDate: opp.closeDate };
        }
        if (opp.classification === 'lost' || opp.classification === 'rejected' || stageNorm === 'closed lost' || stageNorm === 'rejected') {
          return { opportunityId: d.opportunityId, status: 'lost', amount: opp.amount, closedDate: opp.lostDate ?? opp.closeDate };
        }
        const cd = opp.closeDate ? getDateAtUtcStart(opp.closeDate) : null;
        if (cd && cd < now) {
          return { opportunityId: d.opportunityId, status: 'pushed', amount: opp.amount, closedDate: opp.closeDate };
        }
        return { opportunityId: d.opportunityId, status: 'pending', amount: opp.amount, closedDate: opp.closeDate };
      });
      const updated: ForecastSnapshot = {
        ...snap,
        closedWonTotal,
        closedWonCount,
        reconciledAt: now.toISOString(),
        outcomes,
      };
      return { ...s, forecastSnapshots: s.forecastSnapshots.map(x => x.id === snapshotId ? updated : x) };
    });
  }, []);

  const deleteForecastSnapshot = useCallback((snapshotId: string) => {
    setState(s => ({ ...s, forecastSnapshots: s.forecastSnapshots.filter(x => x.id !== snapshotId) }));
  }, []);





  const importDrBatch = useCallback((
    incoming: RawDrRecord[],
    batchMeta: { fileName: string; asOfDate: string; importedAt: string },
  ) => {
    setState(s => {
      const batchId = crypto.randomUUID();
      const { merged, stats } = mergeDrBatch(s.dealRegistrations, incoming, s.opportunities, batchId, batchMeta.importedAt);
      const batch: DrBatch = {
        id: batchId,
        importedAt: batchMeta.importedAt,
        fileName: batchMeta.fileName,
        recordCount: incoming.length,
        newCount: stats.newCount,
        updatedCount: stats.updatedCount,
        rejectedCount: stats.rejectedCount,
        convertedCount: stats.convertedCount,
        asOfDate: batchMeta.asOfDate,
      };
      return {
        ...s,
        dealRegistrations: merged,
        drBatches: [...s.drBatches, batch],
      };
    });
  }, []);

  const clearDrData = useCallback(() => {
    setState(s => ({ ...s, dealRegistrations: [], drBatches: [] }));
  }, []);

  const setManagerQuota = useCallback((year: number, amount: number, notes?: string) => {
    setState(s => {
      const now = new Date().toISOString();
      const existing = s.managerQuotas.find(q => q.year === year);
      const next: ManagerQuota = existing
        ? { ...existing, annualAmount: amount, notes: notes?.trim() || undefined, updatedAt: now }
        : {
            id: crypto.randomUUID(),
            year,
            annualAmount: amount,
            notes: notes?.trim() || undefined,
            createdAt: now,
            updatedAt: now,
          };
      const others = s.managerQuotas.filter(q => q.year !== year);
      return { ...s, managerQuotas: [...others, next] };
    });
  }, []);

  const getManagerQuota = useCallback((year: number): ManagerQuota | undefined => {
    return state.managerQuotas.find(q => q.year === year);
  }, [state.managerQuotas]);

  const computeWeeklySnapshotPayload = useCallback((s: ForecastState): Omit<WeeklySnapshot, 'id' | 'snapshotDate' | 'capturedAt'> => {
    const quarter = getCurrentQuarter();
    const qStart = quarterStart(quarter);
    const qEnd = quarterEnd(quarter);

    const inQuarter = s.opportunities.filter(o => {
      if (!o.closeDate) return false;
      const d = getDateAtUtcStart(o.closeDate);
      if (d < qStart || d > qEnd) return false;
      if (o.classification === 'omitted' || o.classification === 'rejected' || o.classification === 'lost') return false;
      const stageNorm = (o.stage || '').toLowerCase().trim();
      if (stageNorm === 'closed lost' || stageNorm === 'rejected') return false;
      return true;
    });

    const closedWon = inQuarter.filter(o => o.classification === 'closed_won').reduce((a, o) => a + o.amount, 0);
    const commitPipeline = inQuarter.filter(o => o.classification === 'commit').reduce((a, o) => a + o.amount, 0);
    const upsidePipeline = inQuarter.filter(o => o.classification === 'upside').reduce((a, o) => a + o.amount, 0);
    const totalPipeline = inQuarter.reduce((a, o) => a + o.amount, 0);

    const qualifiedStageWords = ['discovery', 'technical', 'commercial', 'purchasing'];
    const qualifiedPipe = inQuarter.filter(o => {
      if (o.classification === 'closed_won') return false;
      const stageNorm = (o.stage || '').toLowerCase().trim();
      const isQualifiedStage = qualifiedStageWords.some(w => stageNorm.includes(w));
      const isQualifiedClass = o.classification === 'commit' || o.classification === 'upside';
      return isQualifiedStage || isQualifiedClass;
    }).reduce((a, o) => a + o.amount, 0);

    const year = qStart.getUTCFullYear();
    const repGoal = s.reps.filter(r => r.isActive !== false).reduce((a, r) => a + (r.quarterlyGoals[quarter] || 0), 0);
    const mgrAnnual = s.managerQuotas.find(q => q.year === year)?.annualAmount || 0;
    const totalGoal = repGoal + mgrAnnual / 4;

    const defensibleCoverage = totalGoal > 0 ? qualifiedPipe / totalGoal : 0;

    return { closedWon, commitPipeline, upsidePipeline, totalPipeline, defensibleCoverage };
  }, []);

  const captureWeeklySnapshot = useCallback((): WeeklySnapshot => {
    const now = new Date();
    const snapshotDate = now.toISOString().slice(0, 10);
    const capturedAt = now.toISOString();
    let created!: WeeklySnapshot;
    setState(s => {
      const existing = s.weeklySnapshots.find(w => w.snapshotDate === snapshotDate);
      if (existing) { created = existing; return s; }
      const payload = computeWeeklySnapshotPayload(s);
      created = { id: crypto.randomUUID(), snapshotDate, capturedAt, ...payload };
      const next = [...s.weeklySnapshots, created]
        .sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate))
        .slice(-104);
      return { ...s, weeklySnapshots: next };
    });
    return created;
  }, [computeWeeklySnapshotPayload]);

  // Auto-capture on Fridays (once per day)
  useEffect(() => {
    const today = new Date();
    if (today.getDay() !== 5) return;
    const todayKey = today.toISOString().slice(0, 10);
    if (state.weeklySnapshots.some(w => w.snapshotDate === todayKey)) return;
    captureWeeklySnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.opportunities.length, state.imports.length]);

  const restoreFromBackup = useCallback((data: {
    reps: Rep[];
    opportunities: Opportunity[];
    imports: ImportRecord[];
    changelog: ChangeLogEntry[];
    snapshots?: OpportunitySnapshot[];
    commissionSettings?: CommissionSettingsMap;
    commissionReviews?: CommissionReviewsMap;
    commissionPinHash?: string | null;
    monthlyRepCommits?: MonthlyRepCommit[];
    monthlyManagerCommits?: MonthlyManagerCommit[];
    forecastPromotions?: ForecastPromotion[];
    forecastSnapshots?: ForecastSnapshot[];
    dealRegistrations?: DealRegistration[];
    drBatches?: DrBatch[];
    managerQuotas?: ManagerQuota[];
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
      monthlyRepCommits: data.monthlyRepCommits || [],
      monthlyManagerCommits: data.monthlyManagerCommits || [],
      forecastPromotions: data.forecastPromotions || [],
      forecastSnapshots: data.forecastSnapshots || [],
      dealRegistrations: data.dealRegistrations || [],
      drBatches: data.drBatches || [],
      managerQuotas: data.managerQuotas || [],
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
    setRepActiveStatus,
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
    updateOpportunityCommissionDetails,
    setCommissionPinHash,
    setMonthlyRepCommit,
    getMonthlyRepCommit,
    getMonthlyCommitsByMonth,
    setMonthlyManagerCommit,
    getMonthlyManagerCommit,
    promoteOpportunityForecast,
    demoteOpportunityForecast,
    isOpportunityPromoted,
    createForecastSnapshot,
    reconcileForecastSnapshot,
    deleteForecastSnapshot,
    importDrBatch,
    clearDrData,
    setManagerQuota,
    getManagerQuota,
    restoreFromBackup,
    getOpportunityHistory,
  };

  if (typeof window !== 'undefined') {
    (window as ForecastContextWindow).__forecastContextValue__ = contextValue;
  }

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
