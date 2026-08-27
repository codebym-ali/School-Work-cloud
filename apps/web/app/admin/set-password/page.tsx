'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { platformApi } from '@/lib/platform-api';

/**
 * Public operator set-password page (SA4b) — the destination of the one-time invite link a Super Admin
 * hands a new operator. It lives on the admin console host and posts to the public
 * `/platform/auth/set-password` (no session; the token is the whole authorisation), then routes to the
 * console login. The admin layout treats this path as public so it isn't bounced to /admin/login.
 *
 * The token is read from `window.location` (not `useSearchParams`) to avoid Next 14's Suspense-boundary
 * build failure.
 */
export default function PlatformSetPasswordPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get('token') ?? '');
  }, []);

  const tooShort = pw.length > 0 && pw.length < 10;
  const mismatch = confirm.length > 0 && pw !== confirm;
  const canSubmit = !!token && pw.length >= 10 && pw === confirm && !busy;

  async function submit() {
    if (!canSubmit || !token) return;
    setBusy(true);
    setMsg(null);
    try {
      await platformApi.setPassword(token, pw);
      setDone(true);
      setMsg({ ok: true, text: 'Password set. You can sign in now.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'That link is invalid or has expired.' });
    } finally {
      setBusy(false);
    }
  }

  if (token === null) {
    return (
      <main className="container" style={{ maxWidth: 420, margin: '10vh auto' }}>
        <p className="muted">Loading…</p>
      </main>
    );
  }

  return (
    <main className="container" style={{ maxWidth: 420, margin: '10vh auto' }}>
      <div className="card stack">
        <h1 style={{ margin: 0, fontSize: 20 }}>Set your operator password</h1>
        {!token ? (
          <div className="toast err">This link is missing its token. Ask a Super Admin for a fresh invite.</div>
        ) : (
          <>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              Choose a password for your vendor-console account. At least 10 characters.
            </p>
            {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}
            {done ? (
              <button onClick={() => router.replace('/admin/login')}>Go to sign in</button>
            ) : (
              <>
                <div>
                  <label htmlFor="pw">New password</label>
                  <input id="pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
                  {tooShort && <p style={{ color: 'var(--danger-ink)', fontSize: 12, margin: '4px 0 0' }}>Use at least 10 characters.</p>}
                </div>
                <div>
                  <label htmlFor="confirm">Confirm password</label>
                  <input
                    id="confirm"
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) submit(); }}
                  />
                  {mismatch && <p style={{ color: 'var(--danger-ink)', fontSize: 12, margin: '4px 0 0' }}>Passwords don&apos;t match.</p>}
                </div>
                <div>
                  <button onClick={submit} disabled={!canSubmit}>{busy ? 'Setting…' : 'Set password'}</button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
