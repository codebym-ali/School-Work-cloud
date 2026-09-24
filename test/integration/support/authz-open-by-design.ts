/**
 * Routes that are INTENTIONALLY reachable by any authenticated principal or are public — the single source
 * of truth shared by the two authz gates:
 *   • `route-authz-coverage.e2e` — every non-public route must declare `@Roles` OR be listed here.
 *   • `route-authz-matrix-coverage.e2e` — every role-gated route must have a permission-matrix row; a route
 *     listed here is exempt because it is public (pre-session) or SELF-SCOPED (the service resolves "me" and
 *     can address no other), so a role×route row would encode the wrong question (see the matrix comments).
 *
 * Adding a line here is a deliberate security decision reviewed by both gates.
 */
export const OPEN_BY_DESIGN: RegExp[] = [
  /^\/api\/v1\/auth\//,                           // login / refresh / logout / mfa — public / session-establishing
  /^\/api\/v1\/portal\//,                         // student portal auth
  /^\/api\/v1\/health/,                           // probes
  /^\/api\/v1\/webhooks\//,                       // signed external callbacks
  // ── self-scoped reads/writes: the service resolves "me" from the session ──
  /^\/api\/v1\/notifications$/,                    // the caller's own notifications
  /^\/api\/v1\/notifications\/seen$/,
  /^\/api\/v1\/timetable\/mine$/,
  /^\/api\/v1\/cover\/mine$/,
  /^\/api\/v1\/attendance\/mine\//,               // the caller's own unmarked registers
  /^\/api\/v1\/attendance\/closure-notice$/,      // school-closure banner — deliberately every authed user
  /^\/api\/v1\/staff-attendance\/mine/,           // own attendance + self check-in state
  /^\/api\/v1\/staff-attendance\/check-in$/,      // self presence claim
  /^\/api\/v1\/staff-leaves(\/balance)?$/,        // own leaves + balance
  /^\/api\/v1\/staff-leaves\/[^/]+\/cancel$/,     // cancel own leave
  /^\/api\/v1\/student-leaves$/,                  // own leaves
  /^\/api\/v1\/student-leaves\/[^/]+\/cancel$/,   // cancel own leave
  /^\/api\/v1\/payslips\/mine$/,                  // own payslips
  /^\/api\/v1\/payslips\/[^/]+\/pdf$/,            // owner/admin check in the service (§22.8)
  /^\/api\/v1\/students\/[^/]+\/report-cards$/,   // ownership-checked in the service (a student sees only their own)
  /^\/api\/v1\/uploads(\/confirm)?$/,             // presigned upload for the caller's own file
];

/** Collapse a concrete or templated path to a comparable shape: every id-like segment → `*`, trailing slash
 *  dropped. A route template's `:param`, a UUID, the nil UUID and an all-digits segment all normalise to `*`,
 *  so a matrix row written with a concrete `00000000-…` id matches the `:id` route it exercises. */
export function normalizePath(path: string): string {
  return path
    .replace(/\/+$/, '')
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) return '*';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '*';
      if (/^\d+$/.test(seg)) return '*';
      // Enum path param (e.g. a DocumentType like PHOTO) → `*`. Every STATIC route segment in this API is
      // lowercase/kebab, so an UPPER_SNAKE segment is always a value bound to a `:param`, never a literal.
      if (/^[A-Z][A-Z0-9_]+$/.test(seg)) return '*';
      return seg;
    })
    .join('/');
}
