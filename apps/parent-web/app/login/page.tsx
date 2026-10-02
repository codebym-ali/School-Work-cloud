'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@sw/api-client';
import { Icon, PasswordInput } from '@sw/ui';

/**
 * Parent portal sign-in. Parents authenticate with their child's registration number + guardian
 * CNIC (a convenience credential, acceptable because the portal is strictly read-only). Auth is
 * enumeration-safe: a wrong reg-no and a wrong CNIC return the same generic error.
 */
export default function ParentLoginPage() {
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
      await api.parentPortal.login(registrationNo.trim(), cnic.trim());
      // On this dedicated origin the portal home is the root route.
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
          <p className="sub">Sign in with your child's registration number and your guardian CNIC.</p>
        </div>
        <div>
          <label htmlFor="registrationNo">Registration number</label>
          <input id="registrationNo" value={registrationNo} onChange={(e) => setRegistrationNo(e.target.value)}
            autoComplete="username" autoFocus required />
        </div>
        <div>
          <label htmlFor="cnic">Guardian CNIC</label>
          <PasswordInput id="cnic" value={cnic} onChange={(e) => setCnic(e.target.value)}
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
