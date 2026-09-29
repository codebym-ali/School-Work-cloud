'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type SalaryStructure } from '@sw/api-client';

const rs = (n: number | string) => `Rs ${Math.round(Number(n)).toLocaleString()}`;
const sum = (o: Record<string, number> | null | undefined) => Object.values(o ?? {}).reduce((n, v) => n + Number(v), 0);

/**
 * A staff member's monthly salary, with its history (Cash Payroll Plan).
 *
 * The schools pay one fixed amount — no allowances or fixed deductions — so the form asks for exactly that: an
 * amount and the date it applies from. A raise is a NEW amount from a date, never an edit, so months already
 * calculated keep the figure they were calculated from.
 *
 * ⚠️ Owner and campus admin only, mirrored from `@Roles` on the salary routes. HR adds staff but does not set
 * their pay, and the accountant pays what payroll says but never sets it.
 *
 * Structures entered before this change may carry allowances; they still count, and the history says so rather
 * than showing a salary that does not match the payslip.
 */
export function SalaryPanel({ staffId, onMsg }: { staffId: string; onMsg: (ok: boolean, text: string) => void }) {
  const [history, setHistory] = useState<SalaryStructure[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 7) + '-01');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.salaries.list(staffId).then(setHistory).catch(() => setHistory([]));
  }, [staffId]);
  useEffect(() => { load(); }, [load]);

  const value = Number(amount.replace(/,/g, ''));
  const valid = amount.trim() !== '' && Number.isFinite(value) && value > 0 && from !== '';

  async function save() {
    setBusy(true);
    try {
      await api.salaries.create(staffId, { basic: value, effectiveFrom: from });
      onMsg(true, `Salary of ${rs(value)} saved, from ${new Date(from).toLocaleDateString('en-GB')}.`);
      setAdding(false); setAmount('');
      load();
    } catch (e) {
      onMsg(false, e instanceof ApiError ? e.message : 'Could not save the salary.');
    } finally { setBusy(false); }
  }

  return (
    <div className="stack" style={{ gap: 8, padding: 10, background: 'var(--bg-muted, #f8fafc)', borderRadius: 8 }}>
      <div className="row" style={{ alignItems: 'center' }}>
        <strong style={{ fontSize: 14 }}>Monthly salary</strong>
        {!adding && (
          <button type="button" className="ghost small" onClick={() => setAdding(true)}>
            {history?.length ? 'Change salary from a date' : 'Set salary'}
          </button>
        )}
      </div>

      {history === null ? <span className="muted" style={{ fontSize: 13 }}>Loading…</span>
        : history.length === 0 ? (
          <span className="toast warn" style={{ margin: 0, fontSize: 13 }}>No salary set. This person is left out of payroll until one is.</span>
        ) : (
          <div className="stack" style={{ gap: 0 }}>
            {history.map((h, i) => {
              const extra = sum(h.allowances);
              const fixed = sum(h.fixedDeductions);
              return (
                <div key={h.id} className="row" style={{ justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px dashed var(--border, #e2e8f0)', opacity: i === 0 ? 1 : 0.6, fontVariantNumeric: 'tabular-nums' }}>
                  <span>
                    From {new Date(h.effectiveFrom).toLocaleDateString('en-GB')}
                    {i === 0 && <span className="badge ok" style={{ marginLeft: 6 }}>current</span>}
                    {(extra > 0 || fixed > 0) && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        Set before fixed salaries: {extra > 0 && `+ ${rs(extra)} allowances`}{extra > 0 && fixed > 0 && ', '}{fixed > 0 && `− ${rs(fixed)} fixed deductions`} still apply
                      </div>
                    )}
                  </span>
                  <strong>{rs(h.basic)}</strong>
                </div>
              );
            })}
          </div>
        )}

      {adding && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 8 }}>
            <div>
              <label htmlFor={`sal-amount-${staffId}`}>Monthly salary (Rs)</label>
              <input id={`sal-amount-${staffId}`} inputMode="numeric" placeholder="e.g. 40000" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div>
              <label htmlFor={`sal-from-${staffId}`}>From</label>
              <input id={`sal-from-${staffId}`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
          </div>
          <p className="field-hint" style={{ margin: 0 }}>Months already calculated are not changed. Payroll uses this amount from the date above.</p>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="small" disabled={!valid || busy} onClick={save}>{busy ? 'Saving…' : 'Save salary'}</button>
            <button type="button" className="ghost small" disabled={busy} onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
