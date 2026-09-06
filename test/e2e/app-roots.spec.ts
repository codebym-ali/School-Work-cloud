import { test, expect } from '@playwright/test';

/**
 * Every front-end app answers at its **bare origin**.
 *
 * ⚠️ **This exists because the same bug shipped twice, in `staff-web` and `owner-web`, and nothing
 * noticed.** Both apps were mounted entirely under the `(app)` route group plus `/login`, so nothing
 * answered `/` — meaning `staff.<school>.schoolworks.com` and `owner.<school>.schoolworks.com`
 * returned "This page could not be found" in production. It hid because **every link inside the
 * product is deep**: the only way to meet the bare origin is to type the domain, which is precisely
 * what a person does when they are told "your school is at owner.greenwood.schoolworks.com" — or
 * when a PWA cold-starts, since `start_url` is `/`.
 *
 * The front-end split multiplied the surface: five apps now have five front doors, and a 404 on one
 * of them is invisible from inside any of the others. This is the cheapest possible guard — one
 * request per app, no session — for a failure whose blast radius is "the product looks broken to
 * someone typing your address".
 *
 * ⚠️ Asserted as **not 404**, not as "renders X": each app's root legitimately differs. The
 * marketing site paints a page, the portal paints a dashboard, and the owner/staff apps redirect to
 * `landingPath(me.roles)` after a `me()` call. Pinning the content here would make this spec a
 * duplicate of the ones that already own those screens, and it would break every time a landing
 * page moved — which is a decision, not a regression.
 */
const APPS = [
  { name: 'web (marketing)', origin: 'http://localhost:3001' },
  { name: 'owner-web', origin: 'http://localhost:3005' },
  { name: 'staff-web', origin: 'http://localhost:3006' },
  { name: 'student-web', origin: 'http://localhost:3003' },
  { name: 'superadmin-web', origin: 'http://localhost:3004' },
];

test.describe('every app has a front door', () => {
  // No session: a 404 at the origin is a 404 whether or not you are signed in, and requiring auth
  // would make this depend on the very apps it is checking.
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const { name, origin } of APPS) {
    test(`${name} answers at /`, async ({ request }) => {
      const res = await request.get(origin);
      expect(res.status(), `${origin}/ must not 404 — someone typing the domain lands here`).toBe(200);
    });
  }
});
