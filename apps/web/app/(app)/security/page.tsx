'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/me-context';
import { MFA_REQUIRED_ROLES } from '@/lib/roles';

type Msg = { ok: boolean; text: string } | null;

/** The shared secret inside an otpauth:// URI — shown for authenticator apps that take a
 *  typed key rather than a scanned QR. */
function secretOf(otpauthUrl: string): string {
  try { return new URL(otpauthUrl).searchParams.get('secret') ?? ''; } catch { return ''; }
}

/**
 * Account security (self-service, every role). Enrol in or turn off two-factor auth. MFA is
 * mandatory for the roles in MFA_REQUIRED_ROLES, which is surfaced as a prompt here and in
 * the app banner.
 */
export default function SecurityPage() {
  const me = useMe();
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [pwd, setPwd] = useState('');
  const [disabling, setDisabling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const enabled = me?.mfaEnabled ?? false;
  const required = (me?.roles ?? []).some((r) => (MFA_REQUIRED_ROLES as readonly string[]).includes(r));

  async function begin() {
    setBusy(true); setMsg(null);
    try {
      const { otpauthUrl: url } = await api.mfa.setup();
      setOtpauthUrl(url);
    } catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not start setup' }); }
    finally { setBusy(false); }
  }

  async function confirm() {
    setBusy(true); setMsg(null);
    try {
      await api.mfa.verify(code);
      setOtpauthUrl(null); setCode('');
      setMsg({ ok: true, text: 'Two-factor authentication is on. You will be asked for a code at every sign-in.' });
      window.location.reload();
    } catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'That code was not accepted' }); }
    finally { setBusy(false); }
  }

  async function turnOff() {
    setBusy(true); setMsg(null);
    try {
      await api.mfa.disable(pwd, code);
      setDisabling(false); setPwd(''); setCode('');
      setMsg({ ok: true, text: 'Two-factor authentication is off.' });
      window.location.reload();
    } catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Password or code invalid' }); }
    finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <h1>Security</h1>
      <p className="muted" style={{ margin: 0 }}>{me?.email}</p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <div className="card stack">
        <div className="row">
          <div>
            <strong style={{ fontSize: 15 }}>Two-factor authentication</strong>
            <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>
              A 6-digit code from an authenticator app, required in addition to your password.
            </p>
          </div>
          <span className={`badge ${enabled ? 'ok' : required ? 'bad' : 'warn'}`}>
            {enabled ? 'On' : required ? 'Required — not set up' : 'Off'}
          </span>
        </div>

        {!enabled && required && !otpauthUrl && (
          <div className="toast err" style={{ margin: 0 }}>
            Your role requires two-factor authentication. Please set it up now.
          </div>
        )}

        {enabled ? (
          disabling ? (
            <div className="stack">
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>Confirm with your password and a current code.</p>
              <div className="inline-form">
                <div><label>Password</label><input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} /></div>
                <div style={{ maxWidth: 140 }}><label>Code</label>
                  <input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" />
                </div>
                <button disabled={!pwd || code.length !== 6 || busy} onClick={turnOff}>{busy ? 'Turning off…' : 'Turn off'}</button>
                <button className="ghost" onClick={() => { setDisabling(false); setPwd(''); setCode(''); }}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="row" style={{ justifyContent: 'flex-start', gap: 10 }}>
              <span className="muted" style={{ fontSize: 13 }}>Your account is protected.</span>
              <button className="ghost small" onClick={() => setDisabling(true)}>Turn off</button>
            </div>
          )
        ) : otpauthUrl ? (
          <div className="stack">
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              Add this key to your authenticator app (Google Authenticator, 1Password, Authy …), then enter the code it shows.
            </p>
            <div>
              <label>Setup key</label>
              <code style={{ display: 'block', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, wordBreak: 'break-all', background: '#f9fafb' }}>
                {secretOf(otpauthUrl) || otpauthUrl}
              </code>
            </div>
            <details>
              <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>Full otpauth link</summary>
              <code style={{ display: 'block', marginTop: 6, fontSize: 11, wordBreak: 'break-all' }}>{otpauthUrl}</code>
            </details>
            <div className="inline-form">
              <div style={{ maxWidth: 160 }}><label>Code from app</label>
                <input inputMode="numeric" maxLength={6} autoFocus value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" />
              </div>
              <button disabled={code.length !== 6 || busy} onClick={confirm}>{busy ? 'Verifying…' : 'Confirm & turn on'}</button>
              <button className="ghost" onClick={() => { setOtpauthUrl(null); setCode(''); }}>Cancel</button>
            </div>
          </div>
        ) : (
          <div><button disabled={busy} onClick={begin}>{busy ? 'Starting…' : 'Set up two-factor'}</button></div>
        )}
      </div>
    </div>
  );
}
