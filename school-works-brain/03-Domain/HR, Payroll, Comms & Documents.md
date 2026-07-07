---
title: HR, Payroll, Comms & Documents
type: domain
updated: 2026-07-06
---

# HR, Payroll, Comms & Documents

## Communication — SMS (§14, §26) ✅ built (M3)
- **Pluggable gateway adapter** behind one interface (v1: `console`; Telenor/Jazz aggregators later). → [[System Architecture]].
- `SmsTemplate` per trigger (`FEE_REMINDER, FEE_RECEIPT, ABSENCE, RESULT_READY, LEAVE_STATUS, ACCOUNT_INVITE, MANUAL`) with `{placeholders}`; defaults seeded on provision.
- **Segments:** GSM-7 (160/153) vs UCS-2 (70/67) for Urdu; charged per segment.
- **Credits:** `SmsCreditLedger` (plan grants BASIC 1k / PLUS 5k / PRO 20k). Balance ≤ 0 blocks non-critical sends; critical (ABSENCE, FEE_RECEIPT) may use a small **overdraft buffer**.
- **Delivery:** every send → `SmsLog`; webhook `POST /webhooks/sms/:provider` (HMAC) updates QUEUED→SENT→DELIVERED/FAILED; ×3 backoff → failed-messages screen + re-queue.
- **PII guard:** unverified numbers never receive student PII (only the invite OTP).
- Runs via the **BullMQ `sms` queue** → `worker` `SmsProcessor`.

## Staff HR & Payroll (§13) — planned (M6)
- `StaffProfile` covers **all** employees (`staffType`), `employeeCode` unique per school, employment status.
- `SalaryStructure` (effective-dated): basic + allowances + fixed deductions.
- **Payroll run** (monthly/campus, OWNER_ADMIN, queued): `gross = basic + Σ allowances`; **attendance-linked deduction** = `(unpaidLeave + unexcusedAbsent) × basic/workingDays`; `net = gross − fixed − attendance`. Payslips DRAFT → run APPROVED locks them. Bank numbers encrypted. → [[Attendance & Leaves]], [[Security & Compliance]].

## Documents & Certificates (§15) — planned (M6)
- `Document` types: `LEAVING_CERT, CHARACTER_CERT, FEE_CLEARANCE, REPORT_CARD, PAYSLIP, RECEIPT`.
- LEAVING_CERT blocked while unpaid invoices exist (OWNER_ADMIN override + reason). Withdrawal workflow: check fees → FEE_CLEARANCE → LEAVING_CERT → close enrollment WITHDRAWN → deactivate portal.
- All files on R2 (versioned); access only via 10-min pre-signed URLs after an ownership check.

**Source:** [[03-database-schema-erd]], blueprint §13–§15, §26.
**Implementation status:** SMS/comms ✅ built and green (M3). HR/payroll/documents ⬜ planned (M6) → [[Progress Tracker]].
