# Feature #3 — Fee Challan Printing (bank-style) (Design Spec)

> **Status:** Design DRAFT (2026-07-19). Release 1. Small build, high demo impact.
> **Goal:** Generate a Pakistani bank-style fee challan/voucher PDF, usable by the front desk (bulk
> print) and by the parent portal (single download from feature #1). One shared generator.

## Open Decisions (confirm before build)

1. **Challan layout — how many copies?** Pakistani norm is a **3-part challan** (Bank Copy / School
   Copy / Parent Copy) side by side on one A4. Recommendation: **3-part**. ⚠️ Confirm, or provide the
   school's existing challan artwork to match.
2. **Bank reconciliation depth.** v1 = **printable PDF only**; parent pays at bank/counter, front desk
   records payment via the existing `FeePayment` flow. Bank paid-file upload / auto-reconciliation →
   **v2**. ⚠️ Confirm v1 stops at PDF (aligns with the #1 "no gateway" decision).
3. **Scannable code.** Include a **QR / barcode** encoding challan number + amount for fast counter
   lookup? Recommendation: **yes, QR** (cheap, speeds front-desk). ⚠️ Confirm.
4. **Bank account details source.** Which bank/branch/account prints on the challan — per school or per
   campus? Recommendation: **per-campus bank config** (chains use different accounts per campus).
   ⚠️ Confirm; may need a small `CampusBankAccount` config.

## 1. Business Analysis

- **Problem:** Schools hand parents a printed challan to pay at the bank. Right now there is no
  print artifact — a blocker for real front-desk use and a very visible demo gap.
- **Who uses it:** front desk / accountant (bulk generate + print for a class/section), parent (download
  own child's challan from the portal).
- **Why small:** invoices, items, discounts, late-fee, gap-free numbering already exist in the fees
  module. This is a **presentation layer** (PDF template) over existing data + a numbering field.
- **Existing foundation:** `FeeInvoice`, `FeeInvoiceItem`, `FeeInvoiceBatch`, `FeeHead`, `FeeStructure`,
  `FeePayment`, `PaymentReversal`; `libs/common/src/pdf/pdf.service.ts` (add a `challan` method);
  `libs/common/src/storage/storage.service.ts` for optional caching of generated PDFs.

## 2. Users & Roles

| Role | Action |
|---|---|
| ACCOUNTANT / front desk | Generate + bulk-print challans (own campus). |
| OWNER_ADMIN / CAMPUS_ADMIN | Same, plus configure bank/branch details. |
| PARENT | Download own child's challan (via feature #1 endpoint). |
| TEACHER / STUDENT / others | No access. |

## 3. Challan Content (domain-accurate)

Each copy shows:
- School + campus name/logo, "Fee Challan" title, **challan/voucher number** (gap-free), issue date,
  **due date**.
- Student: name, GR number, class/section, father/guardian name.
- Bank details: bank name, branch, account title + number (per-campus config).
- **Fee breakdown**: per-head line items (tuition, transport, etc.) with amounts, discounts applied,
  arrears/previous balance, **payable within due date** and **payable after due date (with late fee)**.
- **Two-amount rule:** "Amount After Due Date" = amount + late fee per §12 rules.
- QR/barcode (challan no + amount) [pending Open Decision #3].
- Copy label (Bank Copy / School Copy / Parent Copy), footer notes ("pay before due date to avoid fine").

## 4. Data Model

Mostly reuse. Small additions:
- `FeeInvoice.challanNo` — gap-free challan number (if not already distinct from invoice number).
  Reuse the fees module's gap-free numbering discipline (per school/campus/year series).
- `CampusBankAccount` (optional, per Open Decision #4): `{ schoolId, campusId, bankName, branch,
  accountTitle, accountNumber, iban? }`.
- Optionally cache the rendered PDF in storage keyed by `invoiceId + version` to avoid re-render on
  every parent download; invalidate on invoice change.

## 5. API Surface

Extend `fees.controller.ts`:

| Method + Path | Purpose | Guard |
|---|---|---|
| `GET /fees/invoices/:invoiceId/challan.pdf` | single challan PDF | ACCOUNTANT / CAMPUS_ADMIN / OWNER_ADMIN (own campus) |
| `POST /fees/challans/bulk` `{ sectionId, month }` → PDF/zip | bulk print for a section/class | ACCOUNTANT / CAMPUS_ADMIN / OWNER_ADMIN |
| `GET/PUT /fees/campus-bank-accounts` | per-campus bank config | OWNER_ADMIN / CAMPUS_ADMIN |

Parent-side endpoint (`GET /parent/children/:studentId/fees/:invoiceId/challan.pdf`) is defined in
feature #1 and calls the **same generator**.

## 6. UI

- **Fees screen (front desk):** on an invoice/section list, "Print Challan" (single) and "Bulk Print"
  (whole section for a month) → opens/prints the PDF.
- **Setup screen:** campus bank account config form.
- **Parent portal:** "Download Challan" button on the fee card (feature #1).

## 7. Edge Cases

| Case | Behavior |
|---|---|
| Invoice already fully paid | Challan shows "PAID — for record" watermark; still printable for the file. |
| Partial payment made | Show paid-to-date + remaining; recompute payable within/after due date. |
| After due date | Print the "after due date" amount with late fee per §12; before due date, the plain amount. |
| Discount / scholarship applied | Reflect net per-head amounts (respect the §12 discount-cap invariant — see audit note on stacking). |
| Reversed payment | Outstanding recomputed; challan reflects live balance, never a stale "paid". |
| Bulk print for a large section | Stream/zip; do not block the request thread — offload to worker if > N invoices. |
| Missing bank config | Block with a clear "configure campus bank account first" error, not a broken PDF. |
| Arrears from prior month | Include previous outstanding as an arrears line. |

## 8. Testing Checklist

- PDF renders with correct 3-copy layout, all fields, correct within/after-due amounts.
- Late-fee amount matches §12 logic for a past-due invoice.
- Partial-payment and reversed-payment balances are live-correct.
- QR/barcode encodes the right challan no + amount (if included).
- Bulk generation for a full section completes and paginates/zips correctly.
- Parent download uses the identical generator + output as front desk.
- Permission: TEACHER/STUDENT blocked; parent only own child; campus scoping honored.

## 9. Scalability

- Single-challan render is cheap; **bulk print offloaded to the worker** for large sections to avoid
  request timeouts. Optional PDF caching in R2 keyed by invoice version.

## 10. Build Order

1. Add `challanNo` (if needed) + `CampusBankAccount` config + numbering series.
2. `pdf.service.ts` `challan()` method with the 3-copy A4 template.
3. `GET /fees/invoices/:id/challan.pdf` single endpoint; wire the parent-portal endpoint to it.
4. Bulk endpoint (+ worker offload for large batches).
5. Front-desk + setup UI; parent "Download Challan" button.
6. Tests + brain update.
