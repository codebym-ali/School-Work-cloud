'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@sw/api-client';

/** Matches `ReasonDto` on the API: 1–500 characters. The two must not drift. */
const REASON_MAX = 500;

/**
 * One dialog for every audited correction (plan foundation F1).
 *
 * Reversing a payment, waiving an invoice, withdrawing a student and overriding a precondition share
 * one shape: state the consequence, require a reason, confirm, then report what was recorded. Built
 * once so they cannot drift into four dialogs that each ask for the reason differently — or forget to.
 *
 * ⚠️ **The reason is required, not optional, and the button says so by staying disabled.** The API
 * refuses a blank reason; letting the button submit and then showing the refusal teaches people the
 * reason is a formality to type anything into. It is the only record of WHY money was corrected.
 *
 * ⚠️ **Busy blocks every exit, not just the button.** Escape and the backdrop are ignored while the
 * request is in flight: closing mid-request would leave the person unsure whether a reversal happened,
 * and their natural next move — opening it again — is exactly the double submission to avoid.
 *
 * A caller without two-factor gets `MFA_ENROLMENT_REQUIRED` from the API. That is shown as a link to
 * Security rather than an error, because it is not something they did wrong and it has a one-minute fix.
 */
export function ReasonedActionDialog({
  title,
  consequence,
  confirmLabel,
  reasonLabel = 'Reason',
  reasonPlaceholder,
  destructive = true,
  onConfirm,
  onClose,
}: {
  title: string;
  /** What will happen, in plain words. Shown above the reason field. */
  consequence: React.ReactNode;
  confirmLabel: string;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  destructive?: boolean;
  /** Resolve with a success message to show before closing, or throw. */
  onConfirm: (reason: string) => Promise<string>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsMfa, setNeedsMfa] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { reasonRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const trimmed = reason.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= REASON_MAX && !busy && !done;

  async function confirm() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setNeedsMfa(false);
    try {
      setDone(await onConfirm(trimmed));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'MFA_ENROLMENT_REQUIRED') setNeedsMfa(true);
      else setError(e instanceof ApiError ? e.message : 'That did not go through. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  const danger = destructive ? { background: '#b91c1c', borderColor: '#b91c1c' } : undefined;

  return (
    <div
      role="dialog" aria-modal="true" aria-label={title}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 16 }}
    >
      <div className="card stack" style={{ width: 'min(480px, 100%)', gap: 12, background: '#fff' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>

        {done ? (
          <>
            <div className="toast ok" style={{ margin: 0 }} role="status">{done}</div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" onClick={onClose} autoFocus>Done</button>
            </div>
          </>
        ) : (
          <>
            <div className="muted" style={{ fontSize: 13 }}>{consequence}</div>

            <div>
              <label htmlFor="reasoned-action-reason">{reasonLabel}</label>
              <textarea
                id="reasoned-action-reason" ref={reasonRef} rows={3} maxLength={REASON_MAX}
                value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reasonPlaceholder}
                disabled={busy} style={{ width: '100%', resize: 'vertical' }}
              />
              <div className="field-hint">
                Recorded against your name in the activity log. {trimmed.length}/{REASON_MAX}
              </div>
            </div>

            {needsMfa && (
              <div className="toast warn" style={{ margin: 0 }} role="alert">
                This needs two-factor authentication on your account. Nothing was changed.{' '}
                <Link href="/security" style={{ fontWeight: 600 }}>Set it up — about a minute →</Link>
              </div>
            )}
            {error && <div className="toast err" style={{ margin: 0 }} role="alert">{error}</div>}

            <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <button className="ghost" type="button" disabled={busy} onClick={onClose}>Cancel</button>
              <button type="button" disabled={!canSubmit} onClick={confirm} style={danger}>
                {busy ? 'Working…' : confirmLabel}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
