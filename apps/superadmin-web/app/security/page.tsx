'use client';

import { useState } from 'react';
import { ApiError } from '@sw/http';
import { platformApi } from '@/lib/platform-api';
import { usePlatformMe } from '../me-context';

type Msg = { ok: boolean; text: string } | null;

/** The shared secret inside an otpauth:// URI — shown for authenticator apps that take a typed key
 *  rather than a scanned QR. Same approach as the tenant `/security` page. */
function secretOf(otpauthUrl: string): string {
  try { return new URL(otpauthUrl).searchParams.get('secret') ?? ''; } catch { return ''; }
}

/**
 * The recovery codes, shown ONCE.
 *
 * Everything here serves one goal: that the operator still has these AFTER they close the page.
 * They cannot be fetched again — the server stores hashes — so copy and download are offered up
 * front, and dismissing takes a deliberate click rather than happening on navigation. Mirrors the
 * tenant `/security` recovery-codes card.
 */
function RecoveryCodes({ codes, onDismiss, email }: { codes: string[]; onDismiss: () => void; email: string }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');

  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); }
  }

  function download() {
    const blob = new Blob(
      [`Recovery codes for ${email}\nEach code works once. Keep them somewhere safe and private.\n\n${text}\n`],
      { type: 'text/plain' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="card stack" style={{ borderColor: '#86efac', background: '#f0fdf4' }}>
      <div className="row">
        <strong style={{ fontSize: 15 }}>🔑 Save your recovery codes</strong>
        <span className="badge warn">Shown once</span>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        If you lose your phone, one of these gets you back in. Each works <b>once</b>. They cannot
        be shown again — copy or download them now, and keep them somewhere safe.
      </p>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 6,
        fontFamily: 'ui-monospace, monospace', fontSize: 14,
        background: '#fff', border: '1px solid var(--border)', borderRadius: 8, padding: 12,
      }}>
        {codes.map((c) => <span key={c}>{c}</span>)}
      </div>
      <div className="row" style={{ justifyContent: 'flex-start', gap: 8 }}>
        <button className="ghost small" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
        <button className="ghost small" onClick={download}>Download</button>
        <button className="small" onClick={onDismiss}>I&apos;ve saved them</button>
      </div>
    </div>
  );
}

/**
 * Operator account security (console §24, SA0). Enrol in two-factor auth: begin → scan/enter the
 * key → confirm a code → the recovery codes are shown once. Enrolled state comes from `me.mfaEnabled`
 * (resolved by the shell). There is no self-service turn-off in the platform contract, so this page
 * only offers enrolment.
 */
export default function PlatformSecurityPage() {
  const me = usePlatformMe();
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  /** Shown ONCE, right after they are issued — nothing can read them back afterwards. */
  const [codes, setCodes] = useState<string[] | null>(null);
  const [justEnabled, setJustEnabled] = useState(false);
  const enabled = me.mfaEnabled || justEnabled;

  async function begin() {
    setBusy(true); setMsg(null);
    try {
      const { otpauthUrl: url } = await platformApi.mfaEnrollBegin();
      setOtpauthUrl(url);
    } catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not start setup' }); }
    finally { setBusy(false); }
  }

  async function confirm() {
    setBusy(true); setMsg(null);
    try {
      const { recoveryCodes } = await platformApi.mfaEnrollConfirm(code);
      setOtpauthUrl(null); setCode('');
      // Deliberately NOT reloading: the codes are visible exactly once, and a reload would throw
      // them away the instant they were issued. The badge reads from local state until navigation.
      setCodes(recoveryCodes);
      setJustEnabled(true);
      setMsg({ ok: true, text: 'Two-factor authentication is on. Save your recovery codes before leaving this page.' });
    } catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'That code was not accepted' }); }
    finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <h1>Security</h1>
      <p className="muted" style={{ margin: 0 }}>{me.email}</p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {codes && <RecoveryCodes codes={codes} onDismiss={() => setCodes(null)} email={me.email} />}

      <div className="card stack">
        <div className="row">
          <div>
            <strong style={{ fontSize: 15 }}>Two-factor authentication</strong>
            <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>
              A 6-digit code from an authenticator app, required in addition to your password.
            </p>
          </div>
          <span className={`badge ${enabled ? 'ok' : 'warn'}`}>{enabled ? 'On' : 'Off'}</span>
        </div>

        {enabled ? (
          <span className="muted" style={{ fontSize: 13 }}>Your account is protected.</span>
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
