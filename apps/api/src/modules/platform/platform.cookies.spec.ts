import type { Response } from 'express';
import type { Env } from '@common';
import { setAccessCookie } from '../auth/auth.cookies';
import { setPlatformAccessCookie, setPlatformCsrfCookie, setPlatformRefreshCookie } from './platform.cookies';

/**
 * The scope of EVERY session cookie in the system, pinned.
 *
 * ⚠️ **This is a unit test on purpose, and the integration suite could not replace it.** Every
 * integration spec runs with `COOKIE_DOMAIN=localhost`, a single-label domain that browsers reject
 * as a `Domain` attribute — so the cookie comes out host-only there whatever the code says, and an
 * assertion made against that environment would have passed before this change as loudly as after.
 * A real apex is the only configuration in which the two cookie families differ at all.
 */
describe('session cookies — every door keeps its own', () => {
  const env = { COOKIE_DOMAIN: 'schoolworks.com', COOKIE_SECURE: true } as Env;

  /** A `res.cookie` recorder — nothing here needs a real Express response. */
  const spyRes = () => {
    const calls: Array<{ name: string; options: { domain?: string } }> = [];
    const res = { cookie: (name: string, _v: string, options: { domain?: string }) => { calls.push({ name, options }); } };
    return { res: res as unknown as Response, calls };
  };

  it('sends no Domain, so the console session never leaves its own host', () => {
    const { res, calls } = spyRes();
    setPlatformAccessCookie(res, env, 'tok', 60_000);
    setPlatformRefreshCookie(res, env, 'ref', 60_000);
    setPlatformCsrfCookie(res, env, 'csrf');
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.options.domain).toBeUndefined();
  });

  it('sends no Domain on the TENANT session either, so the three doors coexist', () => {
    // ⚠️ This assertion was the exact opposite a commit ago, and the reversal is the feature.
    //
    // With `Domain=<apex>` all three tenant doors shared one `access_token`, so signing into the
    // student portal silently evicted the staff session in the same browser — an office computer
    // could not hold the fee screen and a parent's portal view at once. Each door has its own login
    // page on its own origin, so nothing needed the sharing.
    const { res, calls } = spyRes();
    setAccessCookie(res, env, 'tok', 60_000);
    expect(calls[0].options.domain).toBeUndefined();
  });

  it('keeps the two families under DIFFERENT names, which is what lets superadmin coexist', () => {
    // Host-only alone would not be enough if the names collided: superadmin and an owner session
    // both live at hosts under the apex, and it is the distinct NAME that keeps the tenant guards
    // from ever seeing a platform token.
    const { res, calls } = spyRes();
    setAccessCookie(res, env, 'tok', 60_000);
    setPlatformAccessCookie(res, env, 'tok', 60_000);
    expect(calls[0].name).not.toBe(calls[1].name);
  });
});
