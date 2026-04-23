import { Fragment, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Calculator, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { CommissionReviewsMap, CommissionSettingsMap, Opportunity, Rep } from '@/types/forecast';
import { getMonthLabel } from '@/types/forecast';
import { buildCommissionReview } from '@/lib/commissionUtils';
import { normalizeRepName } from '@/lib/repUtils';

const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const percentFormatter = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 2 });

function formatProgress(booked: number, quota: number): string {
  if (quota <= 0) return `${currencyFormatter.format(booked)} booked`;
  return `${currencyFormatter.format(booked)} / ${currencyFormatter.format(quota)} (${(booked / quota * 100).toFixed(0)}%)`;
}

interface CommissionTrackerProps {
  reps: Rep[];
  opportunities: Opportunity[];
  commissionSettings: CommissionSettingsMap;
  commissionReviews: CommissionReviewsMap;
  onMonthActualChange: (repName: string, monthKey: string, actualTotal?: number) => void;
  onOpportunityReviewChange: (repName: string, monthKey: string, opportunityId: string, updates: { actualCommission?: number; note?: string }) => void;
  onOpportunityCommissionDetailsChange: (opportunityId: string, updates: Pick<Opportunity, 'commissionMrr' | 'commissionTermYears' | 'commissionPaymentType' | 'commissionSpiff' | 'commissionNotes'>) => void;
}

export default function CommissionTracker({
  reps,
  opportunities,
  commissionSettings,
  commissionReviews,
  onMonthActualChange,
  onOpportunityReviewChange,
  onOpportunityCommissionDetailsChange,
}: CommissionTrackerProps) {
  const latestMonth = useMemo(() => {
    const rows = buildCommissionReview(opportunities, commissionSettings, commissionReviews);
    return rows.availableMonths[0] || '';
  }, [commissionReviews, commissionSettings, opportunities]);

  const [selectedMonth, setSelectedMonth] = useState(latestMonth);
  const [selectedRep, setSelectedRep] = useState<'all' | string>('all');
  const [anomaliesOnly, setAnomaliesOnly] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!selectedMonth && latestMonth) {
      setSelectedMonth(latestMonth);
      return;
    }
    if (selectedMonth && latestMonth && !buildCommissionReview(opportunities, commissionSettings, commissionReviews).availableMonths.includes(selectedMonth)) {
      setSelectedMonth(latestMonth);
    }
  }, [commissionReviews, commissionSettings, latestMonth, opportunities, selectedMonth]);

  const review = useMemo(
    () => buildCommissionReview(opportunities, commissionSettings, commissionReviews, selectedMonth, selectedRep, anomaliesOnly),
    [anomaliesOnly, commissionReviews, commissionSettings, opportunities, selectedMonth, selectedRep],
  );

  const repOptions = useMemo(() => {
    const activeRepKeys = new Set(review.selectedMonthRows.map(row => row.repKey));
    return reps
      .filter(rep => activeRepKeys.size === 0 || activeRepKeys.has(normalizeRepName(rep.name)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [reps, review.selectedMonthRows]);

  const toggleExpanded = (id: string) => {
    setExpandedRows(current => ({ ...current, [id]: !current[id] }));
  };

  if (review.availableMonths.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
        Closed Won opportunities will appear here once they land in your imported data.
      </div>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-secondary/20 px-4 py-4">
        <div className="min-w-[180px] space-y-1">
          <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Month</label>
          <select
            value={selectedMonth}
            onChange={event => setSelectedMonth(event.target.value)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {review.availableMonths.map(monthKey => (
              <option key={monthKey} value={monthKey}>{getMonthLabel(monthKey)}</option>
            ))}
          </select>
        </div>
        <div className="min-w-[180px] space-y-1">
          <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Rep</label>
          <select
            value={selectedRep}
            onChange={event => setSelectedRep(event.target.value as 'all' | string)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <option value="all">All reps</option>
            {repOptions.map(rep => {
              const repKey = normalizeRepName(rep.name);
              return (
                <option key={rep.id} value={repKey}>{rep.name}</option>
              );
            })}
          </select>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Button type="button" variant={anomaliesOnly ? 'default' : 'outline'} size="sm" onClick={() => setAnomaliesOnly(current => !current)}>
            <AlertTriangle className="mr-1.5 h-3.5 w-3.5" />
            {anomaliesOnly ? 'Showing anomalies' : 'Show anomalies only'}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {review.summaries.map(summary => (
          <div key={`${summary.repKey}-${summary.monthKey}`} className="rounded-md border border-border bg-background px-4 py-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold text-foreground">{summary.repName}</h4>
                <p className="text-xs text-muted-foreground">{getMonthLabel(summary.monthKey)} • {summary.dealCount} deal{summary.dealCount === 1 ? '' : 's'}</p>
              </div>
              {summary.missingSettings && (
                <span className="rounded-md border border-border bg-secondary px-2 py-1 text-[11px] font-medium text-muted-foreground">
                  Missing settings
                </span>
              )}
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between"><span className="text-muted-foreground">Expected total</span><span className="font-mono text-foreground">{currencyFormatter.format(summary.expectedTotal)}</span></div>
              <div className="flex items-center justify-between"><span className="text-muted-foreground">Statement total</span><span className="font-mono text-foreground">{summary.actualTotal === undefined ? '—' : currencyFormatter.format(summary.actualTotal)}</span></div>
              <div className="flex items-center justify-between"><span className="text-muted-foreground">Entered row total</span><span className="font-mono text-foreground">{currencyFormatter.format(summary.rowActualTotal)}</span></div>
              <div className="flex items-center justify-between"><span className="text-muted-foreground">Total variance</span><span className="font-mono text-foreground">{summary.totalVariance === undefined ? '—' : currencyFormatter.format(summary.totalVariance)}</span></div>
              <div className="flex items-center justify-between"><span className="text-muted-foreground">Flagged rows</span><span className="font-mono text-foreground">{summary.flaggedRows}</span></div>
            </div>
            <div className="mt-3 border-t border-border pt-3">
              <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">Company statement total</label>
              <Input
                type="number"
                step="0.01"
                value={summary.actualTotal ?? ''}
                onChange={event => onMonthActualChange(summary.repName, summary.monthKey, event.target.value === '' ? undefined : Number(event.target.value))}
                className="font-mono"
              />
            </div>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/40 text-left">
              <th className="w-10 px-3 py-2.5" />
              <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Close Date</th>
              <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Rep</th>
              <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Opportunity</th>
              <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Expected</th>
              <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Accelerator context</th>
              <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Company Statement</th>
              <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Variance</th>
              <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Note</th>
            </tr>
          </thead>
          <tbody>
            {review.selectedMonthRows.map(row => {
              const isExpanded = !!expandedRows[row.opportunityId];
              return (
                <Fragment key={row.opportunityId}>
                  <tr className="border-b border-border align-top last:border-0">
                    <td className="px-3 py-3">
                      <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={() => toggleExpanded(row.opportunityId)}>
                        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </Button>
                    </td>
                    <td className="px-4 py-3 font-mono text-foreground">{new Date(row.closeDate).toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-foreground">{row.repName}</td>
                    <td className="px-4 py-3">
                      <div className="space-y-1">
                        <p className="font-medium text-foreground">{row.opportunityName}</p>
                        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                          <span>ACV {currencyFormatter.format(row.annualAcv)}</span>
                          <span>LTC {row.ltcMultiplier.toFixed(2)}x</span>
                          <span>Accel {row.accelerator.toFixed(1)}x</span>
                          <span>Qtr {row.quarterKey}</span>
                          {row.hitCap && <span>Cap hit</span>}
                          {row.missingSettings && <span>Needs plan inputs</span>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-foreground">
                      <div>{currencyFormatter.format(row.expectedCommission)}</div>
                      <div className="text-xs text-muted-foreground">{currencyFormatter.format(row.amount)} booked</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      <div className="space-y-1">
                        <div className="flex items-center gap-1"><Calculator className="h-3.5 w-3.5" /> Starting attainment for accelerator</div>
                        <div>Booked before: {formatProgress(row.quarterBookedBefore, row.quarterlyQuota)}</div>
                        <div>Booked after: {formatProgress(row.quarterBookedAfter, row.quarterlyQuota)}</div>
                        <div>Band applied: {row.acceleratorLabel}</div>
                        <div>Base rate: {percentFormatter.format(row.baseRate)}</div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Input
                        type="number"
                        step="0.01"
                        value={row.actualCommission ?? ''}
                        onChange={event => onOpportunityReviewChange(row.repName, row.monthKey, row.opportunityId, {
                          actualCommission: event.target.value === '' ? undefined : Number(event.target.value),
                          note: row.note,
                        })}
                        className="min-w-[120px] font-mono"
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-foreground">
                      {row.variance === undefined ? '—' : currencyFormatter.format(row.variance)}
                    </td>
                    <td className="px-4 py-3">
                      <Textarea
                        value={row.note ?? ''}
                        onChange={event => onOpportunityReviewChange(row.repName, row.monthKey, row.opportunityId, {
                          actualCommission: row.actualCommission,
                          note: event.target.value,
                        })}
                        placeholder="Investigate mismatch"
                        className="min-h-[72px] min-w-[180px] resize-y"
                      />
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="border-b border-border bg-secondary/10 last:border-0">
                      <td />
                      <td colSpan={8} className="px-4 py-4">
                        <div className="grid gap-4 lg:grid-cols-[repeat(4,minmax(0,1fr))]">
                          <div className="space-y-1.5">
                            <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Commission MRR</label>
                            <Input
                              type="number"
                              step="0.01"
                              value={row.commissionMrr ?? ''}
                              onChange={event => onOpportunityCommissionDetailsChange(row.opportunityId, {
                                commissionMrr: event.target.value === '' ? undefined : Number(event.target.value),
                                commissionTermYears: row.commissionTermYears,
                                commissionPaymentType: row.commissionPaymentType,
                                commissionSpiff: row.commissionSpiff,
                                commissionNotes: row.commissionNotes,
                              })}
                              className="font-mono"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Term years</label>
                            <Input
                              type="number"
                              step="1"
                              min="1"
                              value={row.commissionTermYears}
                              onChange={event => onOpportunityCommissionDetailsChange(row.opportunityId, {
                                commissionMrr: row.commissionMrr,
                                commissionTermYears: event.target.value === '' ? undefined : Number(event.target.value),
                                commissionPaymentType: row.commissionPaymentType,
                                commissionSpiff: row.commissionSpiff,
                                commissionNotes: row.commissionNotes,
                              })}
                              className="font-mono"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Payment type</label>
                            <select
                              value={row.commissionPaymentType}
                              onChange={event => onOpportunityCommissionDetailsChange(row.opportunityId, {
                                commissionMrr: row.commissionMrr,
                                commissionTermYears: row.commissionTermYears,
                                commissionPaymentType: event.target.value as 'annual' | 'upfront',
                                commissionSpiff: row.commissionSpiff,
                                commissionNotes: row.commissionNotes,
                              })}
                              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                            >
                              <option value="annual">Annual</option>
                              <option value="upfront">Upfront</option>
                            </select>
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">SPIFF</label>
                            <Input
                              type="number"
                              step="0.01"
                              value={row.commissionSpiff || ''}
                              onChange={event => onOpportunityCommissionDetailsChange(row.opportunityId, {
                                commissionMrr: row.commissionMrr,
                                commissionTermYears: row.commissionTermYears,
                                commissionPaymentType: row.commissionPaymentType,
                                commissionSpiff: event.target.value === '' ? undefined : Number(event.target.value),
                                commissionNotes: row.commissionNotes,
                              })}
                              className="font-mono"
                            />
                          </div>
                        </div>
                        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,1fr)]">
                          <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-3">
                            <div>Annual ACV used: <span className="font-mono text-foreground">{currencyFormatter.format(row.annualAcv)}</span></div>
                            <div>Quarter quota: <span className="font-mono text-foreground">{currencyFormatter.format(row.quarterlyQuota)}</span></div>
                            <div>Prior quarter payout: <span className="font-mono text-foreground">{currencyFormatter.format(row.priorQuarterPayout)}</span></div>
                            <div>LTC multiplier: <span className="font-mono text-foreground">{row.ltcMultiplier.toFixed(2)}x</span></div>
                            <div>Accelerator: <span className="font-mono text-foreground">{row.accelerator.toFixed(1)}x</span></div>
                            <div>Cap status: <span className="font-mono text-foreground">{row.hitCap ? 'Capped' : 'Not capped'}</span></div>
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Commission details note</label>
                            <Textarea
                              value={row.commissionNotes ?? ''}
                              onChange={event => onOpportunityCommissionDetailsChange(row.opportunityId, {
                                commissionMrr: row.commissionMrr,
                                commissionTermYears: row.commissionTermYears,
                                commissionPaymentType: row.commissionPaymentType,
                                commissionSpiff: row.commissionSpiff,
                                commissionNotes: event.target.value,
                              })}
                              placeholder="Add post-close details from the calculator"
                              className="min-h-[100px] resize-y"
                            />
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {review.selectedMonthRows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No rows match the current month/filter selection.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
