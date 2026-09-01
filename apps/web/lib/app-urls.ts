/**
 * Origins of the split front-end apps (Front-End Instance Separation Plan, Phase 4).
 *
 * `apps/web` is the apex marketing + login-chooser app; the actual sign-in doors and the school app
 * live on their own origins now, so links to them are CROSS-ORIGIN. Set `NEXT_PUBLIC_*_URL` per
 * environment (prod: the subdomains under schoolworks.com); dev defaults to the local ports the
 * dev servers use. These are `NEXT_PUBLIC_` so they're inlined into the client bundle.
 *
 * ⚠️ Owner/Staff/Student are TENANT-scoped, so in production their URL carries the school subdomain
 * (e.g. `https://owner.<school>.schoolworks.com`). The marketing apex has no tenant context, so it
 * cannot know which school — the deployed value is typically a school-picker or the tenant's own
 * subdomain; see [[Deployment & Operations]].
 */
export const APP_URLS = {
  owner: process.env.NEXT_PUBLIC_OWNER_URL || 'http://localhost:3005',
  staff: process.env.NEXT_PUBLIC_STAFF_URL || 'http://localhost:3006',
  student: process.env.NEXT_PUBLIC_STUDENT_URL || 'http://localhost:3003',
  superadmin: process.env.NEXT_PUBLIC_SUPERADMIN_URL || 'http://localhost:3004',
} as const;
