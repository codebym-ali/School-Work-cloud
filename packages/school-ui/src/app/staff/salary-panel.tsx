'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type SalaryStructure } from '@sw/api-client';

const rs = (n: number | string) => `Rs ${Number(n).toLocaleString()}`;
const sum = (o: Record<string, number> | null | undefined) => Object.values(o ?? {}).reduce((n, v) => n + Number(v), 0);

type Line = { label: string; amount: string };

/**
 * A staff member's pay, with its history (GAP-05).
 *
 * Payroll computes from the structure in force for each month, so a raise is a NEW structure from a date,
 * never an edit — editing would silently change what past months were calculated from. The history is
 * shown so "what was she paid in March" has an answer.
 *
 * ⚠️ Owner and campus admin only — mirrored from `@Roles` on the salary routes. HR creates employees but does
 * not set their pay: one person must not be able to invent a staff member on a salary unobserved.
 */
export function SalaryPanel({ staffId, onMsg }: { staffId: string; onMsg: (ok: boolean, text: string) => void }) {
  const [history, setHistory] = useState<SalaryStructure[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [basic, setBasic] = useState('');
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 7) + '-01');
  const [allowances, setAllowances] = useState<Line[]>([]);
  const [deductions, setDeductions] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.salaries.list(staffId).then(setHistory).catch(() => setHistory([]));
  }, [staffId]);
  useEffect(() => { load(); }, [load]);

  const toRecord = (lines: Line[]) =>
    Object.fromEntries(lines.filter((l) => l.label.trim() && Number(l.amount) > 0).map((l) => [l.label.trim(), Number(l.amount)]));
  const valid = Number(basic) >= 0 && basic.trim() !== '' && from !== ''
    && [...allowances, ...deductions].every((l) => (!l.label.trim() && !l.amount) || (l.label.trim() && Number(l.amount) > 0));

  async function save() {
    setBusy(true);
    try {
      await api.salaries.create(staffId, { basic: Number(basic), allowances: toRecord(allowances), deductionsFixed: toRecord(deductions), effectiveFrom: from });
      onMsg(true, `Salary saved, in force from ${new Date(from).toLocaleDateString()}.`);
      setAdding(false); setBasic(''); setAllowances([]); setDeductions([]);
      load();
    } catch (e) {
      onMsg(false, e instanceof ApiError ? e.message : 'Could not save the salary.');
    } finally { setBusy(false); }
  }

  const current = history?.[0];

  return (
    <div className="stack" style={{ gap: 8, padding: 10, background: 'var(--bg-muted, #f8fafc)', borderRadius: 8 }}>
      <div className="row" style={{ alignItems: 'center' }}>
        <strong style={{ fontSize: 14 }}>Salary</strong>
        {!adding && <button type="button" className="ghost small" onClick={() => setAdding(true)}>{current ? '+ New salary from a date' : '+ Set salary'}</button>}
      </div>

      {history === null ? <span className="muted" style={{ fontSize: 13 }}>Loading…</span>
        : history.length === 0 ? (
          <span className="toast warn" style={{ margin: 0, fontSize: 13 }}>No salary set — this person is left out of payroll until one is.</span>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>From</th><th style={{ textAlign: 'right' }}>Basic</th><th style={{ textAlign: 'right' }}>Allowances</th><th style={{ textAlign: 'right' }}>Fixed deductions</th><th style={{ textAlign: 'right' }}>Gross</th></tr></thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={h.id} style={{ opacity: i === 0 ? 1 : 0.65 }}>
                    <td>{new Date(h.effectiveFrom).toLocaleDateString()}{i === 0 && <span className="badge ok" style={{ marginLeft: 6 }}>current</span>}</td>
                    <td style={{ textAlign: 'right' }}>{rs(h.basic)}</td>
                    <td style={{ textAlign: 'right' }} title={Object.entries(h.allowances ?? {}).map(([k, v]) => `${k}: ${v}`).join(', ')}>{rs(sum(h.allowances))}</td>
                    <td style={{ textAlign: 'right' }} title={Object.entries(h.fixedDeductions ?? {}).map(([k, v]) => `${k}: ${v}`).join(', ')}>{rs(sum(h.fixedDeductions))}</td>
                    <td style={{ textAlign: 'right' }}><strong>{rs(Number(h.basic) + sum(h.allowances))}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {adding && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 8 }}>
            <div><label htmlFor={`sal-basic-${staffId}`}>Basic (Rs)</label><input id={`sal-basic-${staffId}`} inputMode="decimal" value={basic} onChange={(e) => setBasic(e.target.value)} /></div>
            <div><label htmlFor={`sal-from-${staffId}`}>In force from</label><input id={`sal-from-${staffId}`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          </div>
          <Lines title="Allowances" hint="e.g. House rent, Conveyance" lines={allowances} setLines={setAllowances} />
          <Lines title="Fixed deductions" hint="e.g. Provident fund, Loan" lines={deductions} setLines={setDeductions} />
          <p className="field-hint" style={{ margin: 0 }}>This does not change months already calculated — it applies to payroll from this date.</p>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="small" disabled={!valid || busy} onClick={save}>{busy ? 'Saving…' : 'Save salary'}</button>
            <button type="button" className="ghost small" disabled={busy} onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Lines({ title, hint, lines, setLines }: { title: string; hint: string; lines: Line[]; setLines: (l: Line[]) => void }) {
  const update = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="stack" style={{ gap: 4 }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
      {lines.map((l, i) => (
        <div key={i} className="row" style={{ gap: 6 }}>
          <input aria-label={`${title} name`} placeholder={hint} value={l.label} onChange={(e) => update(i, { label: e.target.value })} />
          <input aria-label={`${title} amount`} inputMode="decimal" placeholder="Rs" value={l.amount} onChange={(e) => update(i, { amount: e.target.value })} style={{ maxWidth: 120 }} />
          <button type="button" className="ghost small" aria-label="Remove line" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <div><button type="button" className="ghost small" onClick={() => setLines([...lines, { label: '', amount: '' }])}>+ Add</button></div>
    </div>
  );
}
