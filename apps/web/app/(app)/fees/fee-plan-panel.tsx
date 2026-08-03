'use client';

import { useMemo, useState } from 'react';
import { api, ApiError, type AcademicYear, type FeeHead, type FeeStructure, type Klass } from '@/lib/api';

/** Invoicing only ever charges these two, so offering the others would configure nothing. */
const FREQUENCIES = ['MONTHLY', 'ANNUAL'] as const;
const rs = (n: number) => `Rs ${n.toLocaleString()}`;

/**
 * A class's fee plan, as one card per class rather than a flat table of every price in the
 * school. The question an owner asks is "what does 9th cost?", and the old screen could only
 * answer it by making them add rows up by eye.
 *
 * Several rows may exist for the same head — they are a price HISTORY. The card shows the price
 * in force now, with earlier and future ones behind a toggle, because a plan that lists three
 * tuition figures at once reads as three charges.
 */
export function FeePlanPanel({ heads, structures, classes, years, classLabel, onMsg, reload }: {
  heads: FeeHead[]; structures: FeeStructure[]; classes: Klass[]; years: AcademicYear[];
  classLabel: (c: Klass) => string;
  onMsg: (ok: boolean, text: string) => void;
  reload: () => Promise<void>;
}) {
  const currentYear = years.find((y) => y.isCurrent) ?? years[0] ?? null;
  const [openClassId, setOpenClassId] = useState<string | null>(null);
  const [busy, setBusy] = useState('');

  const headName = (id: string) => heads.find((h) => h.id === id)?.name ?? 'Unknown fee';
  const yearStructures = useMemo(
    () => structures.filter((s) => !currentYear || s.academicYearId === currentYear.id),
    [structures, currentYear],
  );

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try { await fn(); await reload(); onMsg(true, ok); }
    catch (e) { onMsg(false, e instanceof ApiError ? e.message : 'That did not work'); }
    finally { setBusy(''); }
  }

  const priced = classes.filter((c) => yearStructures.some((s) => s.classId === c.id));
  const unpriced = classes.filter((c) => !yearStructures.some((s) => s.classId === c.id));

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <h2 style={{ margin: 0, fontSize: 17 }}>Fee plans</h2>
          <span className="muted" style={{ fontSize: 13 }}>
            {currentYear ? currentYear.name : <span className="error">Set a current school year first</span>}
          </span>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          What each class is charged. A price change is recorded from the month it starts, so bills
          already sent keep the figure they were worked out from.
        </p>

        {/* The gap that stops invoicing, named rather than left to be discovered at billing time. */}
        {unpriced.length > 0 && (
          <div className="toast warn">
            {unpriced.length} class{unpriced.length === 1 ? '' : 'es'} have no fees yet — no invoices can be
            generated for {unpriced.map(classLabel).join(', ')}.
          </div>
        )}
      </div>

      {[...priced, ...unpriced].map((c) => (
        <ClassFeeCard
          key={c.id}
          klass={c}
          label={classLabel(c)}
          heads={heads}
          rows={yearStructures.filter((s) => s.classId === c.id)}
          classes={classes}
          classLabel={classLabel}
          currentYear={currentYear}
          years={years}
          open={openClassId === c.id}
          busy={busy}
          headName={headName}
          onToggle={() => setOpenClassId(openClassId === c.id ? null : c.id)}
          run={run}
        />
      ))}
    </div>
  );
}

function ClassFeeCard({ klass, label, heads, rows, classes, classLabel, currentYear, years, open, busy, headName, onToggle, run }: {
  klass: Klass; label: string; heads: FeeHead[]; rows: FeeStructure[];
  classes: Klass[]; classLabel: (c: Klass) => string;
  currentYear: AcademicYear | null; years: AcademicYear[];
  open: boolean; busy: string; headName: (id: string) => string;
  onToggle: () => void;
  run: (key: string, fn: () => Promise<unknown>, ok: string) => Promise<void>;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [adding, setAdding] = useState(false);
  const [copying, setCopying] = useState(false);
  const [editing, setEditing] = useState<{ id: string; amount: string } | null>(null);

  const today = new Date().toISOString().slice(0, 10);
  // What is being charged NOW: the latest active row per head that has already started.
  const inForce = useMemo(() => {
    const latest = new Map<string, FeeStructure>();
    for (const r of [...rows].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))) {
      if (!r.isActive || r.effectiveFrom.slice(0, 10) > today) continue;
      latest.set(`${r.feeHeadId}:${r.frequency}`, r);
    }
    return [...latest.values()];
  }, [rows, today]);

  const monthly = inForce.filter((r) => r.frequency === 'MONTHLY').reduce((s, r) => s + Number(r.amount), 0);
  const annual = inForce.filter((r) => r.frequency === 'ANNUAL').reduce((s, r) => s + Number(r.amount), 0);
  const inForceIds = new Set(inForce.map((r) => r.id));
  const others = rows.filter((r) => !inForceIds.has(r.id));

  return (
    <div className="card stack">
      <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <strong style={{ minWidth: 90 }}>{label}</strong>
        {rows.length === 0
          ? <span className="badge warn">No fees set</span>
          : (
            <span style={{ fontSize: 15 }}>
              <b>{rs(monthly)}</b> <span className="muted" style={{ fontSize: 13 }}>per month</span>
              {annual > 0 && <span className="muted" style={{ fontSize: 13 }}> · {rs(annual)} yearly</span>}
            </span>
          )}
        <div className="row" style={{ gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
          <button className="ghost small" onClick={onToggle}>{open ? 'Hide' : 'Manage'}</button>
        </div>
      </div>

      {open && (
        <div className="stack" style={{ gap: 10 }}>
          <table>
            <thead><tr><th>Fee</th><th>Amount</th><th>How often</th><th>From</th><th></th></tr></thead>
            <tbody>
              {inForce.map((r) => (
                <tr key={r.id}>
                  <td>{headName(r.feeHeadId)}</td>
                  <td>
                    {editing?.id === r.id ? (
                      <input type="number" min={1} value={editing.amount} style={{ width: 110 }} autoFocus
                        onChange={(e) => setEditing({ id: r.id, amount: e.target.value })} />
                    ) : rs(Number(r.amount))}
                  </td>
                  <td><span className="badge">{r.frequency === 'MONTHLY' ? 'Every month' : 'Once a year'}</span></td>
                  <td className="muted">{r.effectiveFrom.slice(0, 10)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {editing?.id === r.id ? (
                      <>
                        <button className="small" disabled={busy === r.id || !Number(editing.amount)}
                          onClick={() => run(r.id, () => api.feeSetup.updateStructure(r.id, { amount: Number(editing.amount) }), 'Fee updated').then(() => setEditing(null))}>
                          Save
                        </button>
                        <button className="ghost small" onClick={() => setEditing(null)}>Cancel</button>
                      </>
                    ) : (
                      <>
                        {/* The server refuses an edit once this price has been billed and says
                            to add a revision instead — so the button stays available and the
                            explanation arrives when it is actually relevant. */}
                        <button className="ghost small" onClick={() => setEditing({ id: r.id, amount: String(Number(r.amount)) })}>Edit</button>
                        <button className="ghost small" style={{ color: '#b91c1c' }} disabled={busy === r.id}
                          onClick={() => run(r.id, () => api.feeSetup.updateStructure(r.id, { isActive: false }), 'Fee switched off')}>
                          Stop charging
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {inForce.length === 0 && <tr><td colSpan={5} className="muted">Nothing is being charged yet.</td></tr>}
            </tbody>
          </table>

          {others.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              <button className="ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => setShowHistory(!showHistory)}>
                {showHistory ? 'Hide' : 'Show'} past &amp; upcoming prices ({others.length})
              </button>
              {showHistory && (
                <table>
                  <tbody>
                    {others.map((r) => (
                      <tr key={r.id}>
                        <td>{headName(r.feeHeadId)}</td>
                        <td>{rs(Number(r.amount))}</td>
                        <td className="muted">from {r.effectiveFrom.slice(0, 10)}</td>
                        <td>
                          {!r.isActive
                            ? <span className="badge warn">Switched off</span>
                            : r.effectiveFrom.slice(0, 10) > today
                              ? <span className="badge">Starts later</span>
                              : <span className="muted">Replaced</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          <div className="row" style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
            <button className="small" onClick={() => { setAdding(!adding); setCopying(false); }}>
              {adding ? 'Cancel' : '+ Add a fee'}
            </button>
            {rows.length > 0 && (
              <button className="ghost small" onClick={() => { setCopying(!copying); setAdding(false); }}>
                {copying ? 'Cancel' : '📋 Copy this plan'}
              </button>
            )}
          </div>

          {adding && currentYear && (
            <AddFeeForm klass={klass} heads={heads} year={currentYear} busy={busy}
              onDone={() => setAdding(false)} run={run} />
          )}
          {copying && currentYear && (
            <CopyPlanForm klass={klass} classes={classes} classLabel={classLabel} years={years}
              currentYear={currentYear} busy={busy} onDone={() => setCopying(false)} run={run} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Adding a fee, or revising one. The date is the whole point: leaving it at the year start means
 * "this is the fee"; setting a future month records a rise without touching what has been billed.
 */
function AddFeeForm({ klass, heads, year, busy, onDone, run }: {
  klass: Klass; heads: FeeHead[]; year: AcademicYear; busy: string;
  onDone: () => void;
  run: (key: string, fn: () => Promise<unknown>, ok: string) => Promise<void>;
}) {
  const [feeHeadId, setFeeHeadId] = useState('');
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState<string>('MONTHLY');
  const [effectiveFrom, setEffectiveFrom] = useState('');

  const ready = feeHeadId && Number(amount) > 0;
  return (
    <div className="stack" style={{ gap: 8, padding: 12, border: '1px solid #c7d2fe', borderRadius: 8 }}>
      <div className="inline-form">
        <div><label>Fee</label>
          <select value={feeHeadId} onChange={(e) => setFeeHeadId(e.target.value)}>
            <option value="">Select…</option>
            {heads.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        </div>
        <div style={{ maxWidth: 140 }}><label>Amount (Rs)</label>
          <input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div><label>How often</label>
          <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
            {FREQUENCIES.map((f) => <option key={f} value={f}>{f === 'MONTHLY' ? 'Every month' : 'Once a year'}</option>)}
          </select>
        </div>
        <div style={{ maxWidth: 170 }}><label>Starts from</label>
          <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        </div>
        <button disabled={!ready || Boolean(busy)}
          onClick={() => run('add', () => api.feeSetup.createStructure({
            classId: klass.id, feeHeadId, academicYearId: year.id,
            amount: Number(amount), frequency, ...(effectiveFrom ? { effectiveFrom } : {}),
          }), 'Fee added').then(onDone)}>
          Add
        </button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Leave <b>Starts from</b> empty and it applies for the whole year. Set a later month to
        record a price rise — earlier bills keep the old amount.
      </p>
    </div>
  );
}

/** Copy this class's plan to others, or roll it into next year with a rise. */
function CopyPlanForm({ klass, classes, classLabel, years, currentYear, busy, onDone, run }: {
  klass: Klass; classes: Klass[]; classLabel: (c: Klass) => string;
  years: AcademicYear[]; currentYear: AcademicYear; busy: string;
  onDone: () => void;
  run: (key: string, fn: () => Promise<unknown>, ok: string) => Promise<void>;
}) {
  const [targets, setTargets] = useState<string[]>([]);
  const [toYearId, setToYearId] = useState(currentYear.id);
  const [raise, setRaise] = useState('');

  const others = classes.filter((c) => c.id !== klass.id);
  const toggle = (id: string) => setTargets(targets.includes(id) ? targets.filter((x) => x !== id) : [...targets, id]);

  return (
    <div className="stack" style={{ gap: 8, padding: 12, border: '1px solid #c7d2fe', borderRadius: 8 }}>
      <strong style={{ fontSize: 14 }}>Copy {classLabel(klass)}&apos;s fees to…</strong>
      <div className="chips">
        {others.map((c) => (
          <button key={c.id} type="button" className={`chip${targets.includes(c.id) ? ' active' : ''}`} onClick={() => toggle(c.id)}>
            {targets.includes(c.id) ? '✓ ' : ''}{classLabel(c)}
          </button>
        ))}
        {others.length === 0 && <span className="muted" style={{ fontSize: 13 }}>No other classes yet.</span>}
      </div>
      <div className="inline-form">
        <div><label>School year</label>
          <select value={toYearId} onChange={(e) => setToYearId(e.target.value)}>
            {years.map((y) => <option key={y.id} value={y.id}>{y.name}{y.isCurrent ? ' (current)' : ''}</option>)}
          </select>
        </div>
        <div style={{ maxWidth: 150 }}><label>Increase by (%)</label>
          <input type="number" value={raise} placeholder="0" onChange={(e) => setRaise(e.target.value)} />
        </div>
        <button disabled={targets.length === 0 || Boolean(busy)}
          onClick={() => run('copy', () => api.feeSetup.copyPlan({
            fromClassId: klass.id, fromAcademicYearId: currentYear.id,
            toClassIds: targets, toAcademicYearId: toYearId,
            ...(Number(raise) ? { raisePercent: Number(raise) } : {}),
          }), 'Fee plan copied').then(onDone)}>
          Copy to {targets.length || 'no'} class{targets.length === 1 ? '' : 'es'}
        </button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Copies only what is charged now, not past prices. A class that already has that fee is
        left alone — copying never overwrites a price you set on purpose.
      </p>
    </div>
  );
}
