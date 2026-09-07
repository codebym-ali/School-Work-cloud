-- Admission-record fields (Admission Form Field Gaps, Tier 1).
--
-- Everything the form asks for beyond "which section does this child sit in": where they live, their
-- religion (Islamiat vs Ethics streaming, and a printed field on provincial board forms), the person
-- to ring in an emergency, and the parent's occupation.
--
-- All nullable and purely additive: every student admitted before today has none of it, and the
-- form's virtue — seating a walk-in in under a minute — depends on none of them being required.
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "religion" TEXT;
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "address_line" TEXT;
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "city" TEXT;

-- ⚠️ The emergency contact is deliberately NOT a parent_profiles row: it is often a neighbour or an
-- uncle with no custodial relationship, and modelling it as a guardian would put someone in the
-- fee/SMS path who has no business there. Three plain columns say exactly what this is.
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "emergency_name" TEXT;
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "emergency_phone" TEXT;
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "emergency_relation" TEXT;

-- The one column the Father/Mother work needed — the many-guardian shape was already modelled.
ALTER TABLE "parent_profiles" ADD COLUMN IF NOT EXISTS "occupation" TEXT;
