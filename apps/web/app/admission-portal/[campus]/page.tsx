'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { landingPath } from '@/lib/roles';

/**
 * Dedicated, branded Admission Portal login for one campus. The campus admin generates the
 * link (/admission-portal/<campus>) and hands it to their admission controller. Auth is the
 * same school-wide sign-in; after login the controller lands on their admissions panel.
 */
export default function AdmissionPortalLogin() {
  const router = useRouter();
  const params = useParams<{ campus: string }>();
  const campusName = decodeURIComponent(String(params.campus ?? '')).trim();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      <form className="card stack" style={{ width: 380 }} onSubmit={onSubmit}>
        <div>
          <h1>🎓 Admission Portal</h1>
          <p className="sub">{campusName || 'Admissions'}</p>
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
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in to Admissions'}</button>
      </form>
    </main>
  );
}
