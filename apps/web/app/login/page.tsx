'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { landingPath } from '@/lib/roles';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('owner@demo.pk');
  const [password, setPassword] = useState('Owner!Secret12');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [campus, setCampus] = useState<string | null>(null);

  // A per-campus login link (?campus=<name>) just brands this page; auth is the same for
  // the whole school — the user is scoped to their campus after they sign in.
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get('campus');
    if (c) setCampus(c);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(email, password);
      const me = await api.me();
      router.push(landingPath(me.roles));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
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
      </form>
    </main>
  );
}
