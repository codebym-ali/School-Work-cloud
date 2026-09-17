import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from '../../apps/api/src/app.module';

/**
 * Law 3 — every capability has a screen, or a listed name.
 *
 * ⚠️ **A route can ship, pass its tests, carry a permission-matrix row, and be unreachable by a
 * human — and nothing fails.** The IA audit found 18 such routes by hand; the count was wrong three
 * different ways (a per-file prefix bug, a substring heuristic that both over- and under-counted)
 * because *any* file-parsing guess is unreliable. This gate removes the guessing: it reads the
 * **live Express router** (the real, fully-prefixed route table) and checks each route against a
 * scan of `apps/web`. Anything neither called nor allowlisted fails, and the failure prints the
 * exact list — so the "missing UI" backlog is computed, never estimated.
 *
 * Same spirit as the tenant-enrolment assertion in `check-rls-coverage.mjs`, which exists because a
 * gate that only inspects what already opted in cannot see what never did.
 */
describe('Route coverage — every route has a UI or a listed exception (Law 3)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });
  afterAll(async () => { await app?.close(); });

  /**
   * Routes that legitimately have no in-app screen. Each entry is a claim; keep the list short and
   * commented, so adding one is a decision, not a reflex.
   *
   * Prefixes end with `/*` to cover a whole area; exact paths match one route.
   */
  const NO_UI_BY_DESIGN: RegExp[] = [
    /^\/api\/v1\/health(\/|$)/,          // liveness/readiness probes — compose/Traefik, not humans
    /^\/api\/v1\/metrics$/,              // Prometheus scrape
    /^\/api\/v1\/webhooks\//,            // external provider callbacks (fee settlement)
    /^\/api\/v1\/sms\/[^/]+$/,           // POST /sms/:provider — inbound delivery-receipt webhook
    /^\/api\/v1\/platform\//,            // the vendor console (§24) is a SEPARATE app, not apps/web
    /^\/api\/v1\/auth\//,                // login/refresh/logout/reset — the login doors, pre-shell
    /^\/api\/v1\/fees\/jobs\//,          // cron entrypoints (mark-overdue), invoked by the worker
  ];

  /**
   * ⚠️ **The known missing-UI backlog — routes that SHOULD have a screen and do not yet.**
   *
   * Listed so the gate passes today while making the debt explicit and un-loseable. IA3 builds
   * these in risk order and deletes each line as its screen ships. A route NOT on this list and NOT
   * called is a NEW hole — that is the regression this gate stops.
   */
  const MISSING_UI_BACKLOG: RegExp[] = [
    /^\/api\/v1\/sms\/send$/,                       // manual bulk send — needs recipient-picker UI, deferred
    /^\/api\/v1\/auth\/change-password$/,           // belongs on /security (operator: known deferral)

    // ── Finance admin (audited money actions, reachable only by API) ──────────
    /^\/api\/v1\/fees\/integrity-check$/,           // ledger reconciliation

    // ── Payroll (no admin surface at all) ────────────────────────────────────
    /^\/api\/v1\/payroll-runs(\/|$)/,               // create/list/approve a payroll run
    /^\/api\/v1\/payslips\/[^/]+\/mark-paid$/,      // mark a payslip paid
    /^\/api\/v1\/staff\/[^/]+\/salary-structures$/, // set/read a staff salary structure

    // ── Student record actions the profile screen does not expose ────────────
    /^\/api\/v1\/students\/[^/]+\/report-cards$/,               // a student's report cards

    // ── Misc ─────────────────────────────────────────────────────────────────
    /^\/api\/v1\/promotions$/,                      // year-end promotion flow
    /^\/api\/v1\/student-leaves\/[^/]+\/cancel$/,   // a student cancelling their own leave
  ];

  const allow = (p: string) =>
    NO_UI_BY_DESIGN.some((r) => r.test(p)) || MISSING_UI_BACKLOG.some((r) => r.test(p));

  /**
   * One big string of every FRONT-END source file, for caller detection.
   *
   * ⚠️ Since the app was split into five per-audience apps (Front-End Instance Separation Plan), the
   * calling UI no longer lives only in `apps/web`: the API path literals moved to `packages/api-client`,
   * the school screens to `packages/school-ui`, and each app has its own routes. Scanning just
   * `apps/web` made 146 routes look uncovered. This now walks every front-end root — the shared
   * `packages/*` (source only) plus each app's `app/` dir — so a route is "covered" if ANY of them
   * calls it. `existsSync` guards a not-yet-created app dir.
   */
  const readWeb = (): string => {
    const roots = [
      'packages',
      join('apps', 'web', 'lib'),
      join('apps', 'web', 'components'),
      ...['web', 'owner-web', 'staff-web', 'student-web', 'superadmin-web'].map((a) => join('apps', a, 'app')),
    ];
    let out = '';
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.next') continue;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) out += readFileSync(full, 'utf8');
      }
    };
    for (const r of roots) walk(r);
    return out;
  };

  it('every registered route is reachable from a screen, or explicitly exempt', () => {
    const expressApp = app.getHttpAdapter().getInstance() as {
      _router?: { stack: { route?: { path: unknown; methods: Record<string, boolean> } }[] };
    };
    const stack = expressApp._router?.stack;
    if (!Array.isArray(stack)) throw new Error('Could not read the Express router — the gate would be vacuous.');

    const paths = new Set<string>();
    for (const layer of stack) {
      const p = layer.route?.path;
      if (typeof p === 'string' && p.startsWith('/api/v1/')) paths.add(p);
    }
    // Non-vacuous: this app has ~200 routes. A near-empty set means the router read broke.
    expect(paths.size).toBeGreaterThan(150);

    const web = readWeb();
    const called = (full: string): boolean => {
      // Strip the /api/v1 prefix (the client's apiGet/apiPost add it), then match against the web
      // source. A `:param` matches any segment. ⚠️ A LITERAL segment matches its own text OR a
      // `${...}` template hole — because the client legitimately builds some paths dynamically, e.g.
      // `apiGet(`/reports/${key}`)` reaches every `/reports/<name>` route. Without this, a
      // dynamic-key screen reads as if none of its routes had a UI (a false positive). This does NOT
      // over-match a literal sibling: `/students/${id}/status` never matches `/students/:id/withdraw`,
      // because the `status`/`withdraw` segments only collapse to a `${...}` hole, not to each other.
      const rel = full.replace(/^\/api\/v1/, '');
      const escapeRe = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const HOLE = '\\$\\{[^}]+\\}';
      // ⚠️ The FIRST segment is always a literal anchor, never a hole. A bare `/${...}` appears all
      // over the web (every templated path), so collapsing the first segment would make any short
      // route (`/payroll-runs`) match a stray `/${id}` elsewhere. Anchored on its real first
      // segment, a dynamic later segment (`/reports/${key}`) is still covered, and unrelated
      // templates are not.
      const rx = rel
        .split('/')
        .filter(Boolean)
        .map((seg, i) => {
          if (seg.startsWith(':')) return `(?:[^/]+|${HOLE})`;
          return i === 0 ? escapeRe(seg) : `(?:${escapeRe(seg)}|${HOLE})`;
        });
      return new RegExp('/' + rx.join('/')).test(web);
    };

    const uncovered = [...paths].filter((p) => !called(p) && !allow(p)).sort();
    if (uncovered.length) {
      throw new Error(
        `${uncovered.length} route(s) have no caller in apps/web and no listed exception:\n` +
          uncovered.map((p) => `   - ${p}`).join('\n') +
          '\n\nEither build the screen, or (if it is genuinely UI-less) add it to NO_UI_BY_DESIGN, ' +
          'or (if it is known debt) to MISSING_UI_BACKLOG in this file.',
      );
    }
  });
});
