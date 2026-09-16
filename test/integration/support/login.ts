import request from 'supertest';
import type { Response } from 'supertest';
import type { Server } from 'node:http';
import { authenticator } from 'otplib';
import { mfaSecretFor } from './mfa';

/**
 * Sign in through the right door (Owner Login Plan, O2).
 *
 * ⚠️ **The school owner signs in at `/auth/owner-login`; everyone else at `/auth/login`, and each
 * door refuses the other's people.** So a test that logs in has to name the door, and 34 spec files
 * were each hand-rolling their own `login()` wrapper against the staff path.
 *
 * They now share this one. That is not tidiness for its own sake: the failure mode of editing 34
 * copies is that a missed one fails loudly (fine) while a *wrongly* edited one keeps passing while
 * exercising the wrong door (not fine). One helper means one place to be right — the same argument
 * that retired the three hand-copied `drainSms` helpers.
 */
export type LoginDoor = 'staff' | 'owner' | 'auto';

const PATHS = {
  staff: '/api/v1/auth/login',
  owner: '/api/v1/auth/owner-login',
} as const;

/**
 * `auto` — try the staff door, fall back to the owner's.
 *
 * ⚠️ **This is for specs that need *a session*, not for specs testing the boundary.** Roughly 34
 * suites sign in only to get a cookie before exercising something else entirely; making each of
 * them name a door would be ~40 hand edits whose failure mode is silent (a wrongly-edited call site
 * keeps passing while exercising the wrong door).
 *
 * The obvious objection is that a fallback masks a regression — if the staff door started admitting
 * owners again, `auto` would succeed on the first try and say nothing. That is answered by putting
 * the boundary assertion in exactly ONE place instead of relying on 34 incidental ones:
 * `auth.e2e-spec.ts` asserts directly that the staff door refuses an owner and that the owner door
 * refuses everyone else. **Infrastructure here; assertion there.**
 */
async function loginAuto(server: Server, host: string, email: string, password: string): Promise<Response> {
  const staff = await request(server).post(PATHS.staff).set('Host', host).send({ email, password });
  if (staff.status === 200) return staff;
  return request(server).post(PATHS.owner).set('Host', host).send({ email, password });
}

/** The raw response, for tests asserting on status/body (a refused door, a locked account). */
export async function loginRequest(
  server: Server,
  host: string,
  email: string,
  password: string,
  door: LoginDoor = 'auto',
): Promise<Response> {
  const res = door === 'auto'
    ? await loginAuto(server, host, email, password)
    : await request(server).post(PATHS[door]).set('Host', host).send({ email, password });
  return completeMfa(server, host, email, res);
}

/**
 * Finish the second step for an account `enrolMfa` enrolled this run; otherwise return as-is.
 *
 * Specs that enrol an owner so it can reach two-factor-gated routes would otherwise break the first
 * time they sign that owner in again. A challenge for an account enrolled some OTHER way is passed
 * straight through, so a spec testing the challenge itself still sees it.
 */
async function completeMfa(server: Server, host: string, email: string, res: Response): Promise<Response> {
  if (res.status !== 200 || !res.body?.mfaRequired) return res;
  const secret = mfaSecretFor(host, email);
  if (!secret) return res;
  return request(server)
    .post('/api/v1/auth/mfa/challenge')
    .set('Host', host)
    .send({ mfaToken: res.body.mfaToken, code: authenticator.generate(secret) });
}

/**
 * Sign in and return the session cookies, failing loudly if the door refused.
 *
 * ⚠️ Asserting the status here is deliberate. Without it a refused login returns `[]` and the spec
 * carries on unauthenticated, failing later on some unrelated 401/403 — which reads as "that
 * endpoint is broken" rather than "you knocked on the wrong door".
 */
export async function loginAs(
  server: Server,
  host: string,
  email: string,
  password: string,
  door: LoginDoor = 'auto',
): Promise<string[]> {
  const res = await loginRequest(server, host, email, password, door);
  if (res.status !== 200) {
    throw new Error(
      `login failed at the ${door} door for ${email}: ${res.status} ${JSON.stringify(res.body)}`
        + (door === 'staff' ? ' — is this an OWNER_ADMIN? owners use the owner door.' : ''),
    );
  }
  return res.headers['set-cookie'] as unknown as string[];
}

/** The school owner's door. Named so call sites read as the rule rather than as a string argument. */
export function loginAsOwner(server: Server, host: string, email: string, password: string): Promise<string[]> {
  return loginAs(server, host, email, password, 'owner');
}
