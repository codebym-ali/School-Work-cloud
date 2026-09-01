'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, isMfaRequired, type LoginResult } from '@sw/api-client';
import { landingPath } from '@sw/roles';

/**
 * The email + password sign-in form, shared by the staff door (`/login`) and the owner's own
 * door (`/owner-login`).
 *
 * ⚠️ **Extracted rather than copied, because of the second step.** Both doors return either a
 * session or `{ mfaRequired, mfaToken }`, and the token then has to be exchanged for a session
 * before any authenticated call will work. That exchange is the fiddly part — and the owner is the
 * role most likely to have MFA on, since `OWNER_ADMIN` is in `MFA_REQUIRED_ROLES`. A second copy
 * would have been the `drainSms` mistake again: the same defect fixed once per copy, months apart.
 *
 * The doors differ only in `signIn` (which endpoint), the wording, and the cross-links — never in
 * how a session is obtained.
 */
export function EmailPasswordSignIn({
  title, subtitle, signIn, footer, prefill,
}: {
  title: string;
  subtitle: string;
  /** The door: `api.login` or `api.ownerLogin`. */
  signIn: (email: string, password: string) => Promise<LoginResult>;
  /** Links to the other doors. Every sign-in page names the others. */
  /** Optional cross-door links. Omitted on the split apps (owner/staff), which are single-door origins. */
  footer?: ReactNode;
  prefill?: { email: string; password: string };
}) {
  const router = useRouter();
  const [email, setEmail] = useState(prefill?.email ?? '');
  const [password, setPassword] = useState(prefill?.password ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set when the account has MFA on: the door returned a pending token instead of a session,
  // and it must be exchanged for one with a 6-digit code before any authed call will work.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');

  async function land() {
    const me = await api.me();
    router.push(landingPath(me.roles));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await signIn(email, password);
      // MFA accounts get no session here — pause for the code instead of calling /auth/me,
      // which would 401 and look like a failed password.
      if (isMfaRequired(res)) {
        setMfaToken(res.mfaToken);
        return;
      }
      await land();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.mfa.challenge(mfaToken!, code);
      await land();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Verification failed');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  if (mfaToken) {
    return (
      <main className="center">
        <form className="card stack" style={{ width: 360 }} onSubmit={onVerify}>
          <div>
            <h1>Two-factor code</h1>
            <p className="sub">Enter the 6-digit code from your authenticator app.</p>
          </div>
          <div>
            <label htmlFor="code">Authentication code</label>
            <input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456" required />
          </div>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy || code.length !== 6}>{busy ? 'Verifying…' : 'Verify'}</button>
          <button type="button" className="ghost" onClick={() => { setMfaToken(null); setCode(''); setError(null); }}>
            Back to sign in
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="center">
      <form className="card stack" style={{ width: 360 }} onSubmit={onSubmit}>
        <div>
          <h1>{title}</h1>
          <p className="sub">{subtitle}</p>
        </div>
        <div>
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            autoComplete="username" required />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password" required />
        </div>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {footer}
      </form>
    </main>
  );
}
