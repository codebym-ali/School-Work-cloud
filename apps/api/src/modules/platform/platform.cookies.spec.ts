import type { Response } from 'express';
import type { Env } from '@common';
import { setAccessCookie } from '../auth/auth.cookies';
import { setPlatformAccessCookie, setPlatformCsrfCookie, setPlatformRefreshCookie } from './platform.cookies';

/**
 * The scope of the vendor console's session, pinned.
 *
 * ⚠️ **This is a unit test on purpose, and the integration suite could not replace it.** Every
 * integration spec runs with `COOKIE_DOMAIN=localhost`, a single-label domain that browsers reject
 * as a `Domain` attribute — so the cookie comes out host-only there whatever the code says, and an
 * assertion made against that environment would have passed before this change as loudly as after.
 * A real apex is the only configuration in which the two cookie families differ at all.
 */
describe('platform session cookies — host-only', () => {
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

  it('still shares the TENANT session across subdomains — the two are not the same decision', () => {
    // The contrast is the point. A staff session must survive demo.<apex> → owner.demo.<apex>;
    // making both families host-only would break that and would look like a "consistency" fix.
    const { res, calls } = spyRes();
    setAccessCookie(res, env, 'tok', 60_000);
    expect(calls[0].options.domain).toBe('schoolworks.com');
  });
});
