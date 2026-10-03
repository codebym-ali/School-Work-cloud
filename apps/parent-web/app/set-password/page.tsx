'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError } from '@sw/api-client';
import { Icon, PasswordInput } from '@sw/ui';

export default function SetPasswordPage() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!token) {
    return (
      <main className="center">
        <div className="card stack" style={{ width: 'min(380px, 100%)', textAlign: 'center' }}>
          <Icon name="error" size={40} />
          <h2>Invalid link</h2>
          <p className="sub">This link is invalid or has expired. Please contact your school to get a new one.</p>
          <a href="/login">Back to sign in</a>
        </div>
      </main>
    );
  }

  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const longEnough = password.length >= 8;
  const valid = hasUpper && hasDigit && longEnough;
  const matches = password === confirmPassword && confirmPassword.length > 0;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || !matches) return;
    setBusy(true);
    setError(null);
    try {
      await api.parentPortal.setPassword(token!, password, confirmPassword);
      router.push('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to set password');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <form className="card stack" style={{ width: 'min(380px, 100%)' }} onSubmit={onSubmit}>
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="lock" size={26} /> Set Your Password</h1>
          <p className="sub">Create a password for your parent portal account.</p>
        </div>
        <div>
          <label htmlFor="password">New password</label>
          <PasswordInput id="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password" required />
          <ul style={{ fontSize: '0.8rem', margin: '0.5rem 0 0', paddingLeft: '1.25rem', color: 'var(--fg2, #666)' }}>
            <li style={{ color: longEnough ? 'var(--green, #15803d)' : undefined }}>At least 8 characters</li>
            <li style={{ color: hasUpper ? 'var(--green, #15803d)' : undefined }}>1 uppercase letter</li>
            <li style={{ color: hasDigit ? 'var(--green, #15803d)' : undefined }}>1 digit</li>
          </ul>
        </div>
        <div>
          <label htmlFor="confirmPassword">Confirm password</label>
          <PasswordInput id="confirmPassword" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password" required />
          {confirmPassword && !matches && (
            <p style={{ fontSize: '0.8rem', color: 'var(--red, #dc2626)', margin: '0.25rem 0 0' }}>Passwords do not match</p>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy || !valid || !matches}>
          {busy ? 'Setting password…' : 'Set password & sign in'}
        </button>
      </form>
    </main>
  );
}
