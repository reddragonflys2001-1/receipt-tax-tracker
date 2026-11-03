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


## Update 19: live item reconciliation
- A live item total and subtotal difference appear beneath the editable item list.
- Editing a price or quantity, adding or removing an item, or changing the subtotal updates the live figures immediately.
- The initial OCR warning is labeled as an initial snapshot; it does not overwrite manually edited amounts.
- The receipt's printed item count is preserved for live row-count warnings.
- OCR price recognition is not guaranteed accurate: compare all prices to the original image, especially BP XTR SRSRB.
- The parser has **not** been trained to automatically correct $8.92 to $3.52, because doing so without evidence could corrupt other receipts.


## Update 20: enhanced thermal receipt OCR
- For each image band, OCR now compares the original with a contrast-enhanced grayscale version and uses whichever produces more UPC/price rows.
- The two OCR results are **not** merged, preventing duplicate purchases from alternate passes.
- Recognition will take longer (approximately two passes).
- The 23-item Walmart result is a testing goal, not a guaranteed outcome; visually verify prices, item count, and totals.
- Existing live reconciliation, tax handling and review warnings remain unchanged.


## Update 21 — complementary OCR recovery

- Compares original and enhanced OCR readings for each image section, then keeps extra UPC-anchored item rows found only in the alternate reading.
- Uses UPC occurrence counts to avoid duplicating identical purchases that appear in both OCR readings.
- Accepts the Walmart checkout bag-fee UPC suffix `K` when a readable price is present.
- Preserves manual price correction, live reconciliation, separate tax lines, and the incomplete-item warning.
- **All OCR prices remain suggestions**: visually verify every price, quantity and item against the photo before saving. A second OCR reading is not independent proof of price accuracy.


## Update 22 — conservative OCR merge deduplication
- Extra lines from the second OCR pass now require a higher occurrence count for **both** normalized product description and UPC, not UPC alone.
- This avoids adding a second copy when the two passes disagree about a product UPC but recognize the same item name.
- Legitimate repeated items remain separate when an alternate scan really contains more occurrences.
- Conservative merging may still miss items with unreadable names, and it does not automatically correct prices.
- Re-test the Walmart receipt and compare the entire extracted list with the original before saving.
