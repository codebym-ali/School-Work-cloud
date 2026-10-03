'use client';

import { useState } from 'react';
import { api } from '@sw/api-client';
import { Icon } from '@sw/ui';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.parentPortal.forgotPassword(email.trim());
    } catch {
      // Always show success — never reveal if email exists.
    }
    setSent(true);
    setBusy(false);
  }

  if (sent) {
    return (
      <main className="center">
        <div className="card stack" style={{ width: 'min(380px, 100%)', textAlign: 'center' }}>
          <Icon name="mail" size={40} />
          <h2>Check your email</h2>
          <p className="sub">If this email is registered, we've sent a password reset link. Check your inbox and spam folder.</p>
          <a href="/login">Back to sign in</a>
        </div>
      </main>
    );
  }

  return (
    <main className="center">
      <form className="card stack" style={{ width: 'min(380px, 100%)' }} onSubmit={onSubmit}>
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="lock_reset" size={26} /> Forgot Password</h1>
          <p className="sub">Enter your email and we'll send you a link to reset your password.</p>
        </div>
        <div>
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            autoComplete="username" autoFocus required />
        </div>
        <button type="submit" disabled={busy || !email.trim()}>
          {busy ? 'Sending…' : 'Send reset link'}
        </button>
        <p style={{ textAlign: 'center', fontSize: '0.875rem' }}>
          <a href="/login">Back to sign in</a>
        </p>
      </form>
    </main>
  );
}
