-- Operations Admin role — the owner's school-wide operational deputy (Operations Admin Role Plan).
-- Add the enum value just after OWNER_ADMIN. Postgres requires ADD VALUE outside a transaction block;
-- Prisma runs each migration statement-by-statement, which is fine here (single statement).
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'OPERATIONS_ADMIN' AFTER 'OWNER_ADMIN';
