
Goal: align Sales Compass commission math with the source calculator, add post-close commission detail inputs, and make Closed Won/omitted states sticky so imports cannot overwrite them or reintroduce excluded deals.

1. Extend opportunity data with commission-specific fields that survive imports
- Add optional per-opportunity commission detail fields to `src/types/forecast.ts`, separate from forecast math:
  - `commissionMrr`
  - `commissionTermYears`
  - `commissionPaymentType` (`annual` | `upfront`)
  - `commissionSpiff`
  - `commissionNotes`
- Keep these editable after close so you can enrich deals like Tim Lake’s without changing the imported source fields.
- Include these fields in backup/restore validation in `src/components/DataBackup.tsx`.

2. Make Closed Won and omitted classifications import-safe
- Update `resolveImportedClassification()` in `src/lib/forecastClassification.ts` so manual terminal states are sticky:
  - existing `omitted` always stays `omitted`
  - existing `closed_won` stays `closed_won` unless you explicitly choose to change it in-app
  - existing `lost` stays `lost` unless you explicitly change it in-app
- Preserve the current project rule that omitted has the highest priority.
- Update the startup migration in `src/context/ForecastContext.tsx` so it does not auto-promote stage text over `omitted`, and does not reclassify a manually locked Closed Won record just because a fresh import has a different non-terminal category.
- In `importOpportunities()`, preserve local manual commission detail fields and notes when merging imported records, not just classification.
- Update `src/components/ImportReview.tsx` so the review shows the resolved/sticky classification outcome rather than implying imports will overwrite Closed Won deals.

3. Replace the current commission formula with the source calculator’s model
- Refactor `src/lib/commissionUtils.ts` to use the same payout basis as the source app:
  - annual ACV from the commission basis
  - derived base rate from quota + annual variable comp
  - LTC / multi-year multipliers
  - paid-up-front multipliers
  - quarterly accelerator bands
  - 50% of annual ACV cap
  - SPIFF added after payout logic
- Remove the current monthly bucket-splitting logic as the primary expected commission calculation, since that is what is causing mismatches like `$675.69` vs `$645.81`.
- Keep the utility pure and deterministic so exact source-app examples can be regression tested.

4. Shift the commission settings model to quarter-aware source inputs
- Update `src/components/CommissionSettings.tsx` and related types so settings use the same vocabulary as the source calculator:
  - monthly or quarterly MRR quota basis, whichever matches the source logic exactly
  - annual variable compensation
  - prior booked / prior payout context for the quarter if needed by the source math
- Show derived rate as read-only support text rather than the main editable control.
- Keep per-rep normalization case-insensitive using the existing rep matching rules.

5. Add post-close commission detail editing in the commission review
- Enhance `src/components/CommissionTracker.tsx` so each row can expand or open an inline editor for:
  - commission MRR / basis
  - term years
  - annual vs upfront
  - SPIFF
  - optional commission note
- Recompute expected commission immediately when these details change.
- Make the row show the actual payout drivers:
  - annual ACV used
  - multiplier applied
  - accelerator applied
  - cap status
- Keep the anomaly workflow intact:
  - expected commission
  - company statement amount
  - variance
  - note
  - show anomalies only

6. Keep the UI month-filtered, but compute with the proper source context
- Preserve the month selector and rep filter because that matches your statement review workflow.
- If the source calculator uses quarter-based accelerator context, compute using quarter state while still displaying rows in the selected month.
- Replace the current confusing attainment text with labels that match the actual source logic, such as:
  - starting attainment for accelerator
  - accelerator band applied
  - quota context used for the calculation
- Avoid percentage transitions like `0% -> 445%` unless they are explicitly labeled and meaningful.

7. Harden omitted-deal exclusion everywhere in commission review
- Update commission eligibility logic in `src/lib/commissionUtils.ts` so omitted opportunities never appear, even if:
  - stage text is `Closed Won`
  - the deal was previously migrated
  - an import later tries to reclassify it
- Base eligibility on the normalized app classification, not raw import stage text.

8. Preserve manual local edits during imports
- In `src/context/ForecastContext.tsx`, keep these local/manual fields when an imported opportunity matches an existing one:
  - classification protections
  - notes
  - commission detail fields
  - any other manually maintained commission review metadata tied to that deal
- Treat imported Salesforce data as updating source fields like amount, stage, rep, and close date, while local commission enrichment remains authoritative unless explicitly edited by the user.

9. Add regression coverage for the exact failure modes
- Expand `src/test/commissionUtils.test.ts` to cover:
  - Tim Lake example producing the source-app result near `$645.81`
  - multi-year annual vs upfront multipliers
  - SPIFF handling
  - quarter/accelerator behavior
  - omitted Closed Won deals never appearing
- Add tests for classification merge rules in either `src/test/commissionUtils.test.ts` or a new focused import-classification test:
  - existing `closed_won` is not downgraded by incoming commit/upside/unclassified
  - existing `omitted` is never overwritten
  - manual commission detail fields survive imports
- Add an Import Review regression case so the previewed change list matches the actual sticky merge behavior.

Technical details
- Files to update:
  - `src/types/forecast.ts`
  - `src/lib/forecastClassification.ts`
  - `src/context/ForecastContext.tsx`
  - `src/lib/commissionUtils.ts`
  - `src/components/CommissionSettings.tsx`
  - `src/components/CommissionTracker.tsx`
  - `src/components/ImportReview.tsx`
  - `src/components/DataBackup.tsx`
  - `src/test/commissionUtils.test.ts`
  - likely one new import/classification regression test file
- Key design rule:
  - Imports may refresh Salesforce fields, but they must not overwrite manual Closed Won / omitted intent or manually entered commission-enrichment data.

Expected result
- Once a deal is Closed Won locally, later imports will not downgrade or overwrite that status.
- Omitted deals will stay excluded from commission review permanently.
- You’ll be able to add post-close details like multi-year term, paid-up-front, and SPIFF on each deal, and the commission review will pull them automatically.
- Deals in Sales Compass will match the source calculator much more closely because both apps will use the same commission model.
