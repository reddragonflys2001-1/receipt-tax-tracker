Stage 9 Update 16
- Adds Walmart compact tax-line recognition for OCR such as "TAXI 8.9000 % 3.18".
- If the explicit printed tax and receipt total are readable but subtotal label is absent, suggests subtotal = total - printed tax and clearly warns it must be verified.
- Broadens UPC/price/tax-marker product-line extraction while preserving duplicate rows as separate purchases.
- All extracted Walmart product rows remain OCR suggestions requiring review; no guessed UPC prices.
- Preserves existing receipt, Washington DOR, reports, and Drive backup code.
