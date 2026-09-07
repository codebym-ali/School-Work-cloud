-- Previous academic history + welfare (Admission Form Field Gaps, Tier 2).
--
-- Additive and all nullable, like Tier 1: none of this is needed to seat a child, and the admission
-- form deliberately does NOT ask for it. It is completed on the student profile afterwards, which is
-- the "admit fast, then complete the record" shape the front desk actually works in.

-- Previous school — required for any TRANSFER admission, i.e. most admissions above KG.
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "previous_school" TEXT;
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "last_class_passed" TEXT;
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "last_result" TEXT;
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "reason_for_leaving" TEXT;

-- ⚠️ Tri-state, not a plain boolean: NULL = never asked, FALSE = asked and not received, TRUE = in
-- hand. The middle state is the whole point — a previous school withholding the leaving certificate
-- over unpaid fees is routine, and it surfaces at board registration months later unless it is
-- recorded as an outstanding item now.
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "slc_received" BOOLEAN;

-- Welfare. `medical_notes` is duty of care, not admin: a child collapsing at assembly or on a trip
-- is exactly when nobody has time to ring the office.
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "blood_group" TEXT;
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "medical_notes" TEXT;
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "nationality" TEXT;
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "permanent_address" TEXT;
