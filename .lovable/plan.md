# Fix import data integrity: Close Date & Product

## Root causes

**1. Close Date not updating on re-import**

`src/components/ImportSheet.tsx` reads the workbook with `XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })` — no `cellDates: true`. Excel date cells therefore arrive as **serial numbers** (e.g. `45657`), not date strings.

The importer then runs `new Date(rawDate)` on that number, which JavaScript interprets as **milliseconds since epoch** — so every Excel date collapses to `1970-01-01`. Two different "real" close dates produce the same garbage `1970-01-01` string, so `ImportReview` sees `existing.closeDate === incoming.closeDate`, marks the row **"unchanged"**, leaves it deselected, and the new close date is never written.

(`src/lib/transformSalesforce.ts` avoids this with its own `excelDateToString` helper that uses the `(serial - 25569) * 86400 * 1000` conversion. `ImportSheet` was never given that helper.)

**2. Product column not importing**

The Product mapping itself is correct — `productName` is written when an opportunity is *new*. The bug only hits **existing** opportunities:

- `ImportReview.buildIncomingItems` does not compare `productName`, so a row whose only change is a newly-populated Product is classified as **"unchanged"**, deselected, and skipped.
- Even when other fields force the row into "updated", the changes panel never tells the user that Product is being set, which makes the feature look broken.

## Fix

### A. Robust date parsing in `src/components/ImportSheet.tsx`

Add a `parseImportDate` helper that handles all three forms Excel/CSV exports produce, and call it from the row mapper:

- **Number** → treat as Excel serial: `new Date(Math.round((n - 25569) * 86400 * 1000))`, then format `YYYY-MM-DD` using UTC getters.
- **`YYYY-MM-DD`** ISO string → construct via `Date.UTC(y, m-1, d)`.
- **`M/D/YYYY` or `MM/DD/YYYY`** (Salesforce US default) → construct via `Date.UTC(y, m-1, d)`; reject impossible day/month combos.
- Anything else → empty string (existing behavior).

All output is normalized to `YYYY-MM-DD` so equality checks in `ImportReview` line up with previously-imported values.

### B. Surface Product changes in `src/components/ImportReview.tsx`

In `buildIncomingItems`, add one more diff:

```
if ((existing.productName || '') !== (opp.productName || ''))
  changes.push(`Product: ${existing.productName || '(empty)'} → ${opp.productName || '(empty)'}`);
```

This makes Product-only changes show up as **Updated** (auto-selected), and labels Product changes inside mixed updates so the user can see the field flowing through.

No business-logic changes elsewhere — `ForecastContext.importOpportunities` already spreads `...o` onto the merged record, so `productName` persists once the row is selected.

### Files touched

- `src/components/ImportSheet.tsx` — add `parseImportDate`, replace the inline `new Date(rawDate)` block.
- `src/components/ImportReview.tsx` — add `productName` to the diff list in `buildIncomingItems`.

### Verification

1. Re-import the latest Salesforce export.
2. Confirm rows with a changed Close Date now appear under **Updated** with the real `YYYY-MM-DD → YYYY-MM-DD` diff (no more 1970 dates).
3. Confirm rows that newly gained a Product appear under **Updated** with a `Product: (empty) → <value>` line, and after Apply the Product column in the Opportunity list is populated.
