---
title: HR, Payroll, Comms & Documents
type: domain
updated: 2026-07-14
---

# HR, Payroll, Comms & Documents

## Communication — SMS (§14, §26) ✅ built (M3)
- **Pluggable gateway adapter** behind one interface (v1: `console`; Telenor/Jazz aggregators later). → [[System Architecture]].
- `SmsTemplate` per trigger (`FEE_REMINDER, FEE_RECEIPT, ABSENCE, RESULT_READY, LEAVE_STATUS, ACCOUNT_INVITE, MANUAL`) with `{placeholders}`; defaults seeded on provision.
- **Segments:** GSM-7 (160/153) vs UCS-2 (70/67) for Urdu; charged per segment.
- **Credits:** `SmsCreditLedger` (plan grants BASIC 1k / PLUS 5k / PRO 20k). Balance ≤ 0 blocks non-critical sends; critical (ABSENCE, FEE_RECEIPT) may use a small **overdraft buffer**.
- **Delivery:** every send → `SmsLog`; webhook `POST /webhooks/sms/:provider` (HMAC) updates QUEUED→SENT→DELIVERED/FAILED; ×3 backoff → failed-messages screen + re-queue.
- **PII guard:** unverified numbers never receive student PII. **Phone verification (§14, M7):** `PhoneVerificationService` — admin sends an SMS OTP to a guardian (`POST /students/guardians/:parentId/verify-phone`), the guardian reads it back and it's confirmed (`…/confirm {code}`) → sets `phoneVerifiedAt`, turning SMS on for that number. Code stored HMAC-only (never plaintext), 10-min TTL, 5-attempt cap, 60s resend cooldown; campus-scoped (a restricted admin can only verify a parent who guardians a student in their campus).
- Runs via the **BullMQ `sms` queue** → `worker` `SmsProcessor`.

## Staff HR & Payroll (§13) — ✅ built (M6)
- `StaffProfile` covers **all** employees (`staffType`), `employeeCode` unique per school, employment status.
- `SalaryStructure` (effective-dated): basic + allowances + fixed deductions.
- **Payroll run** (monthly/campus, OWNER_ADMIN, queued): `gross = basic + Σ allowances`; **attendance-linked deduction** = `(unpaidLeave + unexcusedAbsent) × basic/workingDays`; `net = gross − fixed − attendance`. Payslips DRAFT → run APPROVED locks them. Bank numbers encrypted. → [[Attendance & Leaves]], [[Security & Compliance]].

## Documents & Certificates (§15) — ✅ built (M6)
- `Document` types: `LEAVING_CERT, CHARACTER_CERT, FEE_CLEARANCE, REPORT_CARD, PAYSLIP, RECEIPT`.
- LEAVING_CERT blocked while unpaid invoices exist (OWNER_ADMIN override + reason). Withdrawal workflow: check fees → FEE_CLEARANCE → LEAVING_CERT → close enrollment WITHDRAWN → deactivate portal.
- All files on R2 (versioned); access only via 10-min pre-signed URLs after an ownership check.

**Source:** [[03-database-schema-erd]], blueprint §13–§15, §26.
**Implementation status:** SMS/comms ✅ built (M3); HR/payroll/documents ✅ built (M6) — modules `hr/` (staff, payroll) + `documents/`. Promotion (§7) in `enrollment/`; reports/dashboard/audit in `reports/`. Deferred: PDF render + R2 upload for certificates/payslips (fileKey placeholders, needs §22.6 pipeline), report PDF format. → [[Progress Tracker]].
