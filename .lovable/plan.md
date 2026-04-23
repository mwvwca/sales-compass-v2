
Goal: correct the monthly commission review so expected payouts align with the source calculator, attainment context is understandable, and omitted deals never contribute to commission even if their Salesforce stage is Closed Won.

1. Fix the Closed Won vs omitted inclusion rule
- Update the commission dataset builder in `src/lib/commissionUtils.ts` so it excludes any opportunity whose classification is `omitted`, regardless of stage text.
- Keep the filter based on the app’s normalized classification model, not raw stage names.
- Preserve the project rule that omitted opportunities stay excluded from analytics/totals everywhere, including commission review.

2. Correct the expected commission math to match the source app more closely
- Rework the commission settings model so the base rate can be derived the same way as the source calculator instead of forcing direct manual percent entry only.
- Add the source-plan inputs needed for accurate payout math, likely:
  - monthly quota / target
  - annual variable compensation (or equivalent driver for base rate)
- In `src/lib/commissionUtils.ts`, align the calculation flow with the source logic’s units and progression so the expected payout for deals like “Deal REG-Xtant” can land near the expected 3,805.08 instead of overstating/understating due to a mismatched rate or quota basis.
- Keep the pure utility testable and continue processing deals chronologically within each rep/month.

3. Make attainment readable and meaningful
- Replace the current raw `0% -> 445%` style display in `src/components/CommissionTracker.tsx` with clearer wording and context.
- Show attainment as a labeled progress state tied to quota, for example:
  - “Booked before this deal”
  - “Booked after this deal”
  - “Quota progress”
- Add supporting values alongside percentages so users can see the actual booked amount versus monthly quota, not just a percentage jump.
- If the source plan uses a different attainment basis than “deal amount accumulated this month,” label that explicitly so the UI is self-explanatory.

4. Tighten the settings UX so math inputs are less error-prone
- Update `src/components/CommissionSettings.tsx` to reflect the real commission-plan inputs used by the calculator logic.
- Avoid exposing only “Base Rate %” if that is an implementation detail rather than how you think about comp plans.
- If base rate is derived from other settings, either:
  - compute it automatically and display it read-only, or
  - clearly separate “derived rate” from editable inputs.

5. Improve deal-row explanation in the tracker
- Add compact contextual detail per row in `src/components/CommissionTracker.tsx`, such as:
  - quota used
  - booked-before amount
  - booked-after amount
  - tier bucket reached
- Keep the current anomaly workflow intact:
  - expected commission
  - company statement amount
  - variance
  - notes
- Retain “show anomalies only.”

6. Update tests to lock in the corrected behavior
- Expand `src/test/commissionUtils.test.ts` to cover:
  - omitted deals are excluded even if their stage is Closed Won
  - chronological monthly rollup math
  - expected payout for known tier scenarios
  - clearer attainment values based on the revised logic
- Add a regression case specifically for mixed-status opportunities so future stage migrations do not accidentally re-include omitted deals.

Technical details
- Files to update:
  - `src/lib/commissionUtils.ts`
  - `src/types/forecast.ts`
  - `src/components/CommissionSettings.tsx`
  - `src/components/CommissionTracker.tsx`
  - `src/test/commissionUtils.test.ts`
- Likely no storage model rewrite is needed for statement entries or PIN lock; those can remain as-is unless the revised settings require new persisted fields.
- The main issue appears to be a mismatch between the current simplified monthly settings/math and the original calculator’s quota/rate basis, plus the commission review currently filtering only `classification === 'closed_won'` without protecting against the project-wide omitted rule.

Expected result
- Omitted deals will never show in the commission review.
- The tracker will produce more realistic expected commission values for month-end validation.
- Attainment will read as understandable quota progress instead of opaque percentage jumps.
- You’ll still be able to compare expected vs company statement amounts row by row and investigate anomalies quickly.
