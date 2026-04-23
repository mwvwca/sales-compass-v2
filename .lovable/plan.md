
Goal: add a PIN-locked monthly commission review area under Goals that shows the exact Closed Won opportunities contributing to expected commission, lets you enter the company’s statement amounts at both the deal and monthly rep level, and highlights anomalies for investigation.

1. Extend the data model for commission review
- Add a commission settings structure for each rep, matched with the existing case-insensitive rep normalization.
- Add a commission review record for monthly statement validation, storing:
  - rep
  - month key
  - optional actual statement total for that rep/month
  - optional per-opportunity actual statement amount overrides
  - optional notes for anomaly follow-up
- Keep derived expected commissions computed from opportunities + settings rather than permanently stored, so changes to Closed Won deals recalculate automatically.
- Include these new source records in backup/restore with strict Zod validation.

2. Reuse the existing commission math from the other workspace app
- Adapt the math from the NA VAR Calculator’s hidden commission utility into this app as a dedicated commission helper.
- Preserve the tiered payout behavior, caps, and rate-based calculations, but scope the review UI to this app’s actual Closed Won opportunities.
- Make the helper monthly-review friendly by processing deals in chronological order within each rep/month so expected payouts can be tied to specific opportunities.

3. Build monthly deal-level commission attribution
- Create a derived monthly commission dataset from opportunities where:
  - classification is `closed_won`
  - close date maps to the selected month
  - rep is matched via `normalizeRepName()`
- For each included opportunity, calculate and expose:
  - opportunity name
  - rep
  - close date
  - amount
  - expected commission
  - tier/attainment context
  - cap flag if applicable
- This becomes the exact list of opportunities that contributed to that month’s expected commission.

4. Add anomaly comparison fields
- In the monthly commission table, add an editable “Company Statement” value per opportunity row.
- Compute row-level variance:
  - expected commission
  - actual statement amount
  - difference
- Visually flag meaningful mismatches so you can spot cases like expected $200 vs statement $175 immediately.
- Add an optional note field per row for investigation comments.

5. Add monthly rep rollup comparison
- For each rep/month, show a summary above or below the deal table with:
  - expected monthly total
  - entered company statement total
  - variance
  - count of flagged deal mismatches
- Support both comparison methods together:
  - deal-by-deal validation
  - monthly statement total validation
- If row-level actuals are entered, also show the sum of entered rows versus the monthly statement total so missing or extra statement items are obvious.

6. Place the feature under Goals with PIN lock
- Keep the existing quarterly goals table intact.
- Add a second commission section under Goals, collapsed or clearly separated.
- Protect only the commission section with a local PIN gate:
  - set PIN
  - unlock
  - relock
  - change/reset PIN
- Use the same browser-local pattern already proven in the source app:
  - hashed PIN in localStorage
  - unlocked state in sessionStorage
- Label this clearly as privacy obfuscation, not real security, since the app is offline/localStorage-based.

7. Add month and rep review controls
- Add a month selector as the primary scope for the commission review.
- Add rep filtering:
  - All reps
  - single rep
- Keep the table focused on Closed Won only, per your preference.
- Sort rows by close date, then opportunity name, to make statement matching easier.

8. Keep the UI optimized for investigation
- Use a compact table layout suitable for the current app style.
- Suggested columns:
  - Close Date
  - Rep
  - Opportunity
  - Amount
  - Expected Commission
  - Company Statement
  - Variance
  - Note
- Add summary styling for mismatches:
  - neutral when no actual entered
  - positive/negative highlighting when variance exists
- Optionally include a “show only anomalies” toggle so the review is faster once data entry starts.

9. Preserve offline and backup behavior
- Store commission settings, PIN metadata, monthly actual totals, row-level statement entries, and notes in localStorage.
- Update backup export/import schemas to include these records safely.
- Maintain strict limits and validation to avoid corrupting the offline dataset.

10. Test the critical edge cases
- Closed Won opportunities only appear in the review table.
- Monthly grouping uses the existing UTC-safe month helpers.
- Rep matching remains whitespace-tolerant and case-insensitive.
- Deal-level expected commissions roll up correctly to monthly rep totals.
- Row-level statement entries and monthly statement totals persist across reloads.
- Variance flags behave correctly for missing, partial, or mismatched statement inputs.
- Backup/restore preserves all commission review data.
- PIN set/unlock/relock/reset works without exposing commission data when locked.

Technical details
- Existing files likely to update:
  - `src/types/forecast.ts`
  - `src/context/ForecastContext.tsx`
  - `src/components/RepGoalSetup.tsx`
  - `src/components/DataBackup.tsx`
- New files likely to add:
  - `src/lib/commissionUtils.ts`
  - `src/components/CommissionLock.tsx`
  - `src/components/CommissionSettings.tsx`
  - `src/components/CommissionTracker.tsx`
- Source logic to adapt:
  - `NA VAR Calculator/src/lib/commission.ts`
- Storage additions:
  - per-rep commission plan/settings
  - monthly rep statement totals
  - per-opportunity statement entries and notes
  - local PIN hash/session state

Expected result
- In Goals, you’ll unlock a monthly commission review section, pick a month, and see the exact Closed Won opportunities that generated expected commission for each rep.
- You’ll be able to enter what the company statement paid for each deal and/or the monthly rep total, and the app will immediately show variances so anomalies can be investigated quickly.
