Receipt & Tax Tracker — Stage 9 Update 18

Upload the seven files to the root of your existing GitHub repository and commit them. Wait for the GitHub Pages deployment to finish. Test in a new Incognito window to avoid stale cached code.

Changes:
- Added Combined sales tax as a tax type for printed, unsplit sales tax amounts and existing reports/exports.
- Expanded Walmart TAX1/TAXI printed-tax recognition.
- Added a UPC-anchored Walmart item parser that preserves individual repeated items, including the checkout bag fee when it is a printed item row.
- Prefer a more complete UPC-anchored extraction over generic OCR guesses; do not silently alter item prices to force totals to match.
- Retained the incomplete-item and subtotal-reconciliation warnings.
- Updated the service-worker cache identifier.

IMPORTANT: OCR is not guaranteed to recognize all items. Always verify extracted prices and the 23-item count against the original receipt before saving. The receipt's 23 items include the checkout bag fee; do not add a duplicate fee. If a printed amount is unreadable, correct it manually rather than trusting an inferred amount.
