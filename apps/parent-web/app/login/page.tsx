'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@sw/api-client';
import { Icon, PasswordInput } from '@sw/ui';

export default function ParentLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.parentPortal.login(email.trim(), password);
      if ('mustSetPassword' in result && result.mustSetPassword) {
        router.push(`/set-password?token=${encodeURIComponent(result.token)}`);
        return;
      }
      router.push('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <form className="card stack" style={{ width: 'min(380px, 100%)' }} onSubmit={onSubmit}>
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="school" size={26} /> Parent Portal</h1>
          <p className="sub">Sign in with your email and password.</p>
        </div>
        <div>
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            autoComplete="username" autoFocus required />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <PasswordInput id="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password" required />
        </div>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy || !email.trim() || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p style={{ textAlign: 'center', fontSize: '0.875rem' }}>
          <a href="/forgot-password">Forgot password?</a>
        </p>
      </form>
    </main>
  );
}
