/**
 * Re-export shim (Front-End Instance Separation Plan, Phase 0).
 *
 * The API client + its response types now live in the shared `@sw/api-client` package so every
 * split front-end (owner/staff/student/superadmin) can import the SAME client. This shim keeps the
 * app's existing `@/lib/api` and relative `./api` imports working byte-for-byte, so nothing in
 * `apps/web` had to change. New apps import `@sw/api-client` directly.
 */
export * from '@sw/api-client';
