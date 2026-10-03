-- Add MUST_SET_PASSWORD to UserStatus enum (parent portal invite flow)
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'MUST_SET_PASSWORD';
