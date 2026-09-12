import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP_AUDIENCE, appMounts, servesRoute, NAV, type AppName } from './index';

/**
 * The doors must actually differ (Front-End Instance Separation Plan, Phase 4).
 *
 * owner-web and staff-web once mounted the same 33 screens and re-exported the same one-line shell,
 * so they rendered identically for anyone holding admin roles and the split was cosmetic. These
 * tests pin the rule that replaced the hand-kept mount lists, and — crucially — pin it against the
 * FILESYSTEM, because the rule is only worth anything if the routes on disk still agree with it.
 */

const REPO = path.resolve(__dirname, '../../..');
const topSegment = (href: string) => '/' + href.split('/').filter(Boolean)[0];

function mountedOnDisk(app: AppName): string[] {
  const base = path.join(REPO, 'apps', app, 'app', '(app)');
  const found = new Set<string>();
  const walk = (dir: string, prefix: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${prefix}/${e.name}`);
      else if (e.name === 'page.tsx') found.add(topSegment(prefix || '/'));
    }
  };
  walk(base, '');
  return [...found].sort();
}

describe('app audiences', () => {
  it('keeps the owner door to the owner alone', () => {
    // ⚠️ Regression guard: including OPERATIONS_ADMIN here silently widens the door to everything,
    // because the deputy expands to the six roles it covers. That made a first attempt at this a no-op.
    expect(APP_AUDIENCE['owner-web']).toEqual(['OWNER_ADMIN']);
  });

  it('gives the owner door the owner-only screens and not the personal ones', () => {
    const owner = appMounts('owner-web');
    expect(owner).toContain('/campuses');   // OWNER_ADMIN only
    expect(owner).toContain('/dashboard');
    expect(owner).not.toContain('/my-classes');   // TEACHER
    expect(owner).not.toContain('/my-payslips');  // STAFF, TEACHER
    expect(owner).not.toContain('/home');
  });

  it('gives the staff door everything its audience needs, but not Campus Hub', () => {
    const staff = appMounts('staff-web');
    expect(staff).toContain('/my-classes');
    expect(staff).toContain('/home');
    expect(staff).toContain('/dashboard');      // campus admin + accountant land here
    expect(staff).not.toContain('/campuses');   // owner-only
  });

  it('serves every-user screens from both doors', () => {
    // `/security` and `/profile` have no `roles` — they are every user's own business.
    for (const app of ['owner-web', 'staff-web'] as AppName[]) {
      expect(servesRoute(app, '/security')).toBe(true);
      expect(servesRoute(app, '/profile')).toBe(true);
    }
  });

  it('treats an unknown app as unrestricted, preserving pre-split behaviour', () => {
    expect(servesRoute(undefined, '/my-classes')).toBe(true);
    expect(servesRoute(undefined, '/campuses')).toBe(true);
  });
});

describe('mounted routes agree with the rule', () => {
  /**
   * The point of the whole exercise. A route mounted where its audience cannot reach it is dead
   * weight that makes the doors identical again; a route the nav offers but the app does not mount
   * is a 404 with a link pointing at it.
   */
  it.each(['owner-web', 'staff-web'] as AppName[])('%s mounts exactly what its audience can reach', (app) => {
    const onDisk = mountedOnDisk(app);
    const navHrefs = new Set(NAV.map((n) => n.href));
    const expected = appMounts(app).filter((h) => navHrefs.has(h)).sort();

    // Routes on disk that no NAV entry describes are out of scope here (login, break-glass, etc.).
    expect(onDisk.filter((h) => navHrefs.has(h))).toEqual(expected);
  });
});
