'use client';

import { useEffect, useRef, useState } from 'react';

export function ConfirmDialog({ title, body, confirmLabel, onConfirm, onClose }: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<string | null> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { confirmRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function confirm() {
    setBusy(true);
    setError(null);
    const failure = await onConfirm();
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={title}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 50,
        display: 'grid', placeItems: 'center', padding: 16,
      }}>
      <div className="card stack" style={{ width: 'min(460px, 100%)', gap: 12, background: '#fff' }}
        onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>
        <div className="muted" style={{ fontSize: 13 }}>{body}</div>
        {error && <div className="toast err" style={{ margin: 0 }}>{error}</div>}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="ghost" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button ref={confirmRef} type="button" disabled={busy} onClick={confirm}
            style={{ background: '#b91c1c', borderColor: '#b91c1c' }}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
