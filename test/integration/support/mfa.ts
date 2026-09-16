import request from 'supertest';
import { authenticator } from 'otplib';
import type { Server } from 'node:http';

/**
 * Enrol an existing session in two-factor, through the real endpoints, and return its cookies.
 *
 * ⚠️ **Why specs need this since 2026-09-16.** Sensitive routes (`@RequiresMfa`) now refuse an
 * UNENROLLED caller holding a mandatory-MFA role — OWNER_ADMIN, OPERATIONS_ADMIN, ACCOUNTANT. Specs
 * that reverse, waive, reveal a CNIC, approve payroll or change a user's access as one of those
 * roles must enrol first, exactly as a real owner now must.
 *
 * ⚠️ **No second login, and that is the point.** `mfa/verify` re-signs the access cookie with the
 * `mfa` claim, so the SAME session becomes enrolled. Every spec using this therefore also proves the
 * re-sign works: if it regressed, the session would stay unenrolled and the gated call would 403.
 * (A fresh login would not help anyway — an enrolled user is sent to the MFA challenge.)
 *
 * Returns the cookie array with `access_token` replaced; CSRF and refresh are unchanged.
 */
/**
 * Secrets of accounts THIS test run enrolled, keyed by `host|email`.
 *
 * ⚠️ Why the login helper needs them: once an account is enrolled, signing in again returns
 * `{ mfaRequired, mfaToken }` instead of cookies. Several specs sign the same owner in more than
 * once, and patching each call site is exactly the scattered edit `support/login.ts` exists to
 * prevent. So `loginRequest` completes the challenge itself — but only for accounts enrolled here.
 * An account a spec enrolled by hand (mfa-recovery) is not in this map, so a spec asserting on the
 * raw challenge still sees it.
 */
const SECRETS = new Map<string, string>();
const keyOf = (host: string, email: string) => `${host}|${email.toLowerCase()}`;

export function mfaSecretFor(host: string, email: string): string | undefined {
  return SECRETS.get(keyOf(host, email));
}

export async function enrolMfa(server: Server, host: string, cookies: string[]): Promise<string[]> {
  const csrf = (cookies.find((c) => c.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const post = (path: string, body: object) =>
    request(server).post(path).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send(body);

  const setup = await post('/api/v1/auth/mfa/setup', {});
  if (setup.status >= 300) throw new Error(`mfa/setup failed: ${setup.status} ${JSON.stringify(setup.body)}`);
  const secret = new URL(setup.body.otpauthUrl).searchParams.get('secret');
  if (!secret) throw new Error('mfa/setup returned no secret');

  const me = await request(server).get('/api/v1/auth/me').set('Host', host).set('Cookie', cookies);
  if (me.status !== 200 || !me.body.email) throw new Error(`auth/me failed while enrolling: ${me.status}`);

  const verify = await post('/api/v1/auth/mfa/verify', { code: authenticator.generate(secret) });
  if (verify.status !== 200) throw new Error(`mfa/verify failed: ${verify.status} ${JSON.stringify(verify.body)}`);

  SECRETS.set(keyOf(host, me.body.email), secret);

  const fresh = (verify.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith('access_token='));
  if (!fresh) throw new Error('mfa/verify did not re-sign the access cookie — enrolment would not take effect');
  return [...cookies.filter((c) => !c.startsWith('access_token=')), fresh];
}
