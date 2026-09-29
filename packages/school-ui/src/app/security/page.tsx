'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@sw/api-client';
import { useMe } from '@sw/session';
import { MFA_REQUIRED_ROLES } from '@sw/roles';
import { PasswordInput } from '@sw/ui';

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
/**
 * The codes, shown once.
 *
 * Everything here serves one goal: that the user still has these AFTER they close the page.
 * They cannot be fetched again — the server stores argon2 hashes — so copy and download are
 * offered up front, and dismissing takes a deliberate click rather than happening on navigation.
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
 * The owner's display name (Owner UX Phase 2). The header said "owner@demo.pk" because an owner has no staff
 * record to take a name from; this is where they give one. Reloads so the shell picks it up everywhere.
 */
function OwnerNameCard({ current }: { current: string }) {
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const changed = name.trim() !== current.trim();
  async function save() {
    setBusy(true); setErr(null);
    try { await api.setMyName(name); window.location.reload(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not save your name.'); setBusy(false); }
  }
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); if (changed) void save(); }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 17 }}>Your name</h2>
        <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>Shown at the top of every screen, e.g. “Muhammad Ali · Owner”.</p>
      </div>
      <div className="row" style={{ gap: 8, justifyContent: 'flex-start', flexWrap: 'wrap' }}>
        <label htmlFor="owner-name" className="sr-only">Your name</label>
        <input id="owner-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Full name" style={{ maxWidth: 320 }} autoComplete="name" />
        <button type="submit" disabled={busy || !changed}>{busy ? 'Saving…' : 'Save name'}</button>
      </div>
      {err && <div className="toast err" role="alert">{err}</div>}
    </form>
  );
}

export default function SecurityPage() {
  const me = useMe();
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [pwd, setPwd] = useState('');
  const [disabling, setDisabling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  /** Shown ONCE, right after they are issued — nothing can read them back afterwards. */
  const [codes, setCodes] = useState<string[] | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [confirmRegen, setConfirmRegen] = useState(false);

  const [justEnabled, setJustEnabled] = useState(false);
  const enabled = (me?.mfaEnabled ?? false) || justEnabled;
  const required = (me?.roles ?? []).some((r) => (MFA_REQUIRED_ROLES as readonly string[]).includes(r));

  useEffect(() => {
    if (!enabled) return;
    api.mfa.recoveryStatus().then((r) => setRemaining(r.remaining)).catch(() => setRemaining(null));
  }, [enabled]);

  async function regenerate() {
    setBusy(true); setMsg(null);
    try {
      const { recoveryCodes } = await api.mfa.regenerateRecovery();
      setCodes(recoveryCodes);
      setRemaining(recoveryCodes.length);
      setConfirmRegen(false);
      setMsg({ ok: true, text: 'New codes issued. The previous ones no longer work.' });
    } catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not issue new codes' }); }
    finally { setBusy(false); }
  }

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
      const { recoveryCodes } = await api.mfa.verify(code);
      setOtpauthUrl(null); setCode('');
      // Deliberately NOT reloading: the codes are visible exactly once, and a reload would
      // throw them away the instant they were issued — which is the lockout this feature exists
      // to prevent. The badge below reads from local state until the user navigates away.
      setCodes(recoveryCodes);
      setRemaining(recoveryCodes.length);
      setJustEnabled(true);
      setMsg({ ok: true, text: 'Two-factor authentication is on. Save your recovery codes before leaving this page.' });
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
      {me?.roles.includes('OWNER_ADMIN') && <OwnerNameCard current={me.name ?? ''} />}

      {codes && <RecoveryCodes codes={codes} onDismiss={() => setCodes(null)} email={me?.email ?? 'account'} />}

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
                <div><label>Password</label><PasswordInput value={pwd} onChange={(e) => setPwd(e.target.value)} /></div>
                <div style={{ maxWidth: 140 }}><label>Code</label>
                  <input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" />
                </div>
                <button disabled={!pwd || code.length !== 6 || busy} onClick={turnOff}>{busy ? 'Turning off…' : 'Turn off'}</button>
                <button className="ghost" onClick={() => { setDisabling(false); setPwd(''); setCode(''); }}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              <div className="row" style={{ justifyContent: 'flex-start', gap: 10 }}>
                <span className="muted" style={{ fontSize: 13 }}>Your account is protected.</span>
                <button className="ghost small" onClick={() => setDisabling(true)}>Turn off</button>
              </div>

              <div className="row" style={{ justifyContent: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13 }}>
                  Recovery codes:{' '}
                  {remaining == null ? <span className="muted">—</span>
                    : <b style={remaining <= 2 ? { color: '#b91c1c' } : undefined}>{remaining} left</b>}
                </span>
                {/* Running out means being locked out again if the authenticator is lost, so the
                    warning appears while there is still time to act on it. */}
                {remaining != null && remaining <= 2 && (
                  <span className="badge bad">Generate new codes soon</span>
                )}
                {!confirmRegen
                  ? <button className="ghost small" onClick={() => setConfirmRegen(true)}>Generate new codes</button>
                  : (
                    <span className="row" style={{ gap: 6 }}>
                      <span className="muted" style={{ fontSize: 12 }}>This cancels your current codes. Continue?</span>
                      <button className="small" disabled={busy} onClick={regenerate}>{busy ? 'Issuing…' : 'Yes, replace them'}</button>
                      <button className="ghost small" onClick={() => setConfirmRegen(false)}>Cancel</button>
                    </span>
                  )}
              </div>
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
