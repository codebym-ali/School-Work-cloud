-- Scope B: a guardian is a ParentProfile and nothing else (2026-07-29).
--
-- Parents do not get logins — a locked product decision (Key Decisions, 2026-07-28). Minting a
-- User per guardian therefore created a login-less INVITED account, usually with a synthesized
-- `p-<uuid>@invite.local` address, that nothing could ever authenticate. It is why an earlier
-- cleanup had to delete 557 parent accounts.
--
-- `parent_profiles.user_id` becomes nullable rather than being dropped: existing rows keep their
-- link (no data destroyed, no backfill), and new guardians simply do not get one. Nothing in the
-- codebase reads `parentProfile.userId` — verified by grep — so the link was already write-only.
--
-- `email` moves onto the profile because the admission form and the CSV import both collect a
-- guardian email, and it previously lived on the User row being retired. It is contact data, not
-- a credential: no uniqueness, and no auth path reads it. Dropping the column instead would mean
-- silently discarding something the operator typed in.
--
-- The PARENT role stays in the Role enum: it is a LOCKED catalog (consistency-register §31) and
-- removing an enum value is a type rebuild. It is now reserved/unused for new rows.
--
-- CURATED, not raw `prisma migrate diff` output — the usual two exclusions:
--   * DROP INDEX "students_full_name_trgm" (SQL companion Prisma cannot see) — SIXTH occurrence
--   * ALTER TABLE "section_subjects" ALTER COLUMN "id" DROP DEFAULT (unrelated pre-existing drift)

-- AlterTable
ALTER TABLE "parent_profiles" ADD COLUMN     "email" TEXT,
ALTER COLUMN "user_id" DROP NOT NULL;
