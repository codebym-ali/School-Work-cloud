'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type FeeLinkView } from '@/lib/api';

const METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash', BANK_TRANSFER: 'Bank transfer', EASYPAISA: 'EasyPaisa',
  JAZZCASH: 'JazzCash', CHEQUE: 'Cheque', CARD: 'Card',
};
const rs = (n: string | number) => `Rs ${Number(n).toLocaleString()}`;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * The guardian fee page — opened from a link in an SMS, by someone with no account.
 *
 * Written for the actual reader: a parent on a mid-range phone, on mobile data, who has just
 * made a bank transfer and has the screenshot in their gallery. So:
 *  - it lives OUTSIDE the app shell — no sidebar, no nav, nothing to sign into;
 *  - it says what happens next in plain words, because "PENDING" means nothing to them and the
 *    honest message is that the school still has to check it;
 *  - it never claims the fee is paid. Submitting produces a receipt from nobody; the receipt
 *    comes later, from the office, once the money is matched against the bank statement.
 *
 * It shows the child's first name only. That is not an oversight — the link travels by SMS and
 * gets forwarded, so the page must be safe to open in a group chat.
 */
// `params` is a plain object on Next 14 — `Promise` + `use()` is the Next 15 shape, and it
// typechecked happily while crashing the page at runtime with "An unsupported type was passed
// to use()". Caught in the browser, not by tsc.
export default function GuardianFeeLinkPage({ params }: { params: { token: string } }) {
  const { token } = params;

  const [view, setView] = useState<FeeLinkView | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('');
  const [ref, setRef] = useState('');
  const [paidOn, setPaidOn] = useState(today());
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const v = await api.feeLink.view(token);
      setView(v);
      setAmount(v.outstanding);
      setMethod(v.methods.find((m) => m !== 'CASH') ?? v.methods[0] ?? '');
    } catch (e) {
      // Every failure is the same 404 by design, so there is one message: it does not matter to
      // the reader whether the link expired or never existed — the action is the same.
      setGone(e instanceof ApiError ? e.message : 'This link is not working. Ask the school office for a new one.');
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.feeLink.submit(token, {
        amount: Number(amount),
        method,
        transactionRef: ref.trim() || undefined,
        paidOn,
      }, file);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not go through. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (gone) {
    return (
      <main className="center">
        <div className="card stack" style={{ maxWidth: 420, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>Link not valid</h1>
          <p className="muted" style={{ margin: 0 }}>{gone}</p>
        </div>
      </main>
    );
  }
  if (!view) return <main className="center"><p className="muted">Loading…</p></main>;

  if (done || view.pendingClaim) {
    return (
      <main className="center">
        <div className="card stack" style={{ maxWidth: 420, textAlign: 'center' }}>
          <div style={{ fontSize: 40 }} aria-hidden="true">✓</div>
          <h1 style={{ fontSize: 20, margin: 0 }}>Thank you — we have your details</h1>
          {/* The one thing this page must never do is imply the fee is settled. It is not: a
              human has to match it against the bank statement, and that is what issues a receipt. */}
          <p style={{ margin: 0 }}>
            The school will check this against their bank records and confirm it. <strong>This is not a
            receipt</strong> — the office will issue that once the payment is confirmed.
          </p>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            You can close this page. If anything is wrong, call the school office.
          </p>
        </div>
      </main>
    );
  }

  const overdue = new Date(view.dueDate) < new Date();

  return (
    <main className="center">
      <form className="card stack" style={{ maxWidth: 420, width: '100%' }} onSubmit={submit}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0 }}>Fee for {view.studentFirstName}</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            {view.month ? `${view.month}/${view.year}` : view.year} · due {view.dueDate.slice(0, 10)}
            {overdue && ' · overdue'}
          </p>
        </div>

        {view.settled ? (
          <p style={{ margin: 0 }}>This fee is already paid in full. Nothing to do.</p>
        ) : (
          <>
            <div className="card" style={{ background: '#f8fafc', padding: '10px 14px' }}>
              <div className="muted" style={{ fontSize: 12 }}>Amount due</div>
              <div style={{ fontSize: 26, fontWeight: 600 }}>{rs(view.outstanding)}</div>
            </div>

            <div>
              <label>How much did you pay?</label>
              <input type="number" inputMode="decimal" step="0.01" min="1" required
                value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>

            <div>
              <label>How did you pay?</label>
              <select value={method} onChange={(e) => setMethod(e.target.value)} required>
                {view.methods.map((m) => <option key={m} value={m}>{METHOD_LABEL[m] ?? m}</option>)}
              </select>
            </div>

            <div>
              <label>Reference / transaction number</label>
              <input value={ref} onChange={(e) => setRef(e.target.value)}
                placeholder="From your bank or wallet receipt" />
              {/* This is the field the office actually reconciles against, so ask for it in the
                  words the parent sees on their own screen, not ours. */}
              <div className="field-hint">This is how the school finds your payment. Please include it if you can.</div>
            </div>

            <div>
              <label>When did you pay?</label>
              {/* The payer's date, not the upload date — a transfer made on the 8th and sent in
                  on the 12th was still made on the 8th, and the late-fee question turns on it. */}
              <input type="date" max={today()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} required />
            </div>

            <div>
              <label>
                Screenshot or photo of the payment
                {view.proofPolicy === 'REQUIRED' ? '' : ' (optional)'}
              </label>
              <input type="file" accept="image/*,application/pdf"
                required={view.proofPolicy === 'REQUIRED'}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>

            {error && <div className="toast err">{error}</div>}

            <button type="submit" disabled={busy || !method || !amount}>
              {busy ? 'Sending…' : 'Send to the school'}
            </button>
            <p className="muted" style={{ margin: 0, fontSize: 12, textAlign: 'center' }}>
              The school checks this against their bank records before it counts as paid.
            </p>
          </>
        )}
      </form>
    </main>
  );
}
