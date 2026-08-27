'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { platformApi, isPlatformMfaRequired } from '@/lib/platform-api';

// The seed platform-admin email is pre-filled ONLY in `next dev`; prod ships empty.
const IS_DEV = process.env.NODE_ENV === 'development';

export default function PlatformLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState(IS_DEV ? 'admin@platform.pk' : '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set when the operator has MFA on: `login` returned a pending token instead of a session, and it
  // must be exchanged for one with a 6-digit code (or a recovery code) before the console will load.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await platformApi.login(email, password);
      // MFA accounts get no session here — pause for the code instead of pushing to /admin, which
      // would 401 and bounce straight back to this page looking like a failed password.
      if (isPlatformMfaRequired(res)) {
        setMfaToken(res.mfaToken);
        return;
      }
      router.push('/admin');
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
      await platformApi.mfaComplete(mfaToken!, code);
      router.push('/admin');
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
            <p className="sub">Enter the 6-digit code from your authenticator app, or a recovery code.</p>
          </div>
          <div>
            <label htmlFor="code">Authentication code</label>
            <input id="code" inputMode="text" autoComplete="one-time-code" autoFocus
              value={code} onChange={(e) => setCode(e.target.value.trim())}
              placeholder="123456" required />
          </div>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy || code.length < 6}>{busy ? 'Verifying…' : 'Verify'}</button>
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
          <h1>Vendor console</h1>
          <p className="sub">Platform administration</p>
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
      </form>
    </main>
  );
}
