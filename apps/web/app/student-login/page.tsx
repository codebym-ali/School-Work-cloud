'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { landingPath } from '@/lib/roles';

/**
 * Read-only student portal sign-in (#34/#35). Students have no password — they authenticate
 * with their registration number + CNIC/B-Form (a convenience credential, acceptable because
 * the portal is strictly read-only). Auth is enumeration-safe: a wrong reg-no and a wrong CNIC
 * return the same generic error.
 */
export default function StudentLoginPage() {
  const router = useRouter();
  const [registrationNo, setRegistrationNo] = useState('');
  const [cnic, setCnic] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.studentPortal.login(registrationNo.trim(), cnic.trim());
      const me = await api.me();
      router.push(landingPath(me.roles));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <form className="card stack" style={{ width: 380 }} onSubmit={onSubmit}>
        <div>
          <h1>🎒 Student Portal</h1>
          <p className="sub">Sign in with your registration number and CNIC / B-Form.</p>
        </div>
        <div>
          <label htmlFor="registrationNo">Registration number</label>
          <input id="registrationNo" value={registrationNo} onChange={(e) => setRegistrationNo(e.target.value)}
            autoComplete="username" autoFocus required />
        </div>
        <div>
          <label htmlFor="cnic">CNIC / B-Form</label>
          <input id="cnic" value={cnic} onChange={(e) => setCnic(e.target.value)}
            inputMode="numeric" placeholder="12345-1234567-1" autoComplete="off" required />
        </div>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy || !registrationNo.trim() || !cnic.trim()}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
