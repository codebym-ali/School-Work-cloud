'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError, isMfaRequired } from '@/lib/api';
import { landingPath } from '@/lib/roles';

// Demo credentials are pre-filled ONLY in `next dev`; production builds ship empty fields.
const IS_DEV = process.env.NODE_ENV === 'development';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState(IS_DEV ? 'owner@demo.pk' : '');
  const [password, setPassword] = useState(IS_DEV ? 'Owner!Secret12' : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [campus, setCampus] = useState<string | null>(null);
  // Set when the account has MFA on: login returned a pending token instead of a session,
  // and we must exchange it for one with a 6-digit code before any authed call will work.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');

  // A per-campus login link (?campus=<name>) just brands this page; auth is the same for
  // the whole school — the user is scoped to their campus after they sign in.
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get('campus');
    if (c) setCampus(c);
  }, []);

  async function land() {
    const me = await api.me();
    router.push(landingPath(me.roles));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(email, password);
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
          <h1>Sign in</h1>
          <p className="sub">{campus ?? 'School Management'}</p>
        </div>
        <div>
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </div>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {/* The student portal was fully built and reachable only by typing its URL from memory —
            nothing in the app linked to it. This is the page everyone lands on, so it points there. */}
        <p className="muted" style={{ margin: 0, fontSize: 13, textAlign: 'center' }}>
          Student? <Link href="/student-login">Sign in with your registration number →</Link>
        </p>
      </form>
    </main>
  );
}
