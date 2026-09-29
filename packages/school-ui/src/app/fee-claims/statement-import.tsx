'use client';

import { useState, type ChangeEvent } from 'react';
import { api, ApiError, type StatementImportResult, type UnexplainedCredit } from '@sw/api-client';

const rs = (n: string | number) => `Rs ${Number(n).toLocaleString()}`;

/** How each confidence tier is described to the person deciding. */
const TIER: Record<string, { label: string; tone: string }> = {
  EXACT: { label: 'Reference matches', tone: 'ok' },
  STRONG: { label: 'Reference in narration', tone: 'ok' },
  PROBABLE: { label: 'Probable — confirm', tone: 'warn' },
  WEAK: { label: 'Not enough to match', tone: '' },
};

/**
 * Bank statement reconciliation (Fees Gaps Register).
 *
 * The accountant used to read down a statement in another window looking for each claim. They now
 * upload the statement and the matching is done for them.
 *
 * ⚠️ **Nothing here verifies anything.** A match decides what the queue above shows first; turning
 * one into a receipt is still a click on Verify, by a named person. The submission plan is blunt
 * about why: *"Auto-verifying a screenshot is how a school gets defrauded."*
 *
 * ⚠️ **Preview before commit**, like the student CSV import. An accountant mapping their bank's
 * columns for the first time has no idea whether they got it right, and seeing the parsed result is
 * the difference between a mistake they can spot and a table they have to clean up.
 */
export function StatementImport({ onImported }: { onImported: () => void }) {
  const [open, setOpen] = useState(false);
  const [bankLabel, setBankLabel] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState('');
  const [header, setHeader] = useState<string[]>([]);
  const [cols, setCols] = useState({ valueDate: '', credit: '', narration: '', reference: '', counterparty: '' });
  const [result, setResult] = useState<StatementImportResult | null>(null);
  const [unexplained, setUnexplained] = useState<UnexplainedCredit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function readFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(null); setResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      setCsv(text);
      setFileName(file.name);
      // Read the header locally so the column pickers can offer the bank's OWN names. Guessing the
      // mapping server-side would mean guessing at a bank nobody has seen.
      const first = text.replace(/^﻿/, '').split(/\r?\n/)[0] ?? '';
      const names = first.split(',').map((h) => h.replace(/^"|"$/g, '').trim()).filter(Boolean);
      setHeader(names);
      const guess = (...words: string[]) =>
        names.find((n) => words.some((w) => n.toLowerCase().includes(w))) ?? '';
      setCols({
        valueDate: guess('value date', 'date'),
        credit: guess('credit', 'deposit', 'amount'),
        narration: guess('narration', 'description', 'details', 'particulars'),
        reference: guess('reference', 'ref', 'transaction id'),
        counterparty: guess('counterparty', 'payer', 'remitter', 'from'),
      });
    };
    reader.readAsText(file);
  }

  async function run(commit: boolean) {
    setBusy(true); setErr(null);
    try {
      const body = { bankLabel: bankLabel.trim(), fileName: fileName ?? undefined, csv, columns: cols };
      const res = commit ? await api.feeSetup.importStatement(body) : await api.feeSetup.previewStatement(body);
      setResult(res);
      if (commit) onImported();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not read that statement');
    } finally { setBusy(false); }
  }

  async function loadUnexplained() {
    setBusy(true); setErr(null);
    try {
      setUnexplained(await api.feeSetup.unexplainedCredits(60));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not load unexplained credits');
    } finally { setBusy(false); }
  }

  const ready = bankLabel.trim() !== '' && csv !== '' && cols.valueDate !== '' && cols.credit !== '';

  return (
    <div className="card stack">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17 }}>Reconcile against a bank statement</h2>
          <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>
            Upload the statement and the submissions above are matched for you. Verifying stays your decision.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="ghost small" onClick={() => void loadUnexplained()} disabled={busy}>
            Money we can&apos;t explain
          </button>
          {!open && <button className="ghost small" onClick={() => setOpen(true)}>Upload statement</button>}
        </div>
      </div>

      {err && <div className="toast err">{err}</div>}

      {open && (
        <div className="stack">
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))' }}>
            <div>
              <label htmlFor="bank">Bank</label>
              <input id="bank" value={bankLabel} onChange={(e) => setBankLabel(e.target.value)} placeholder="e.g. Meezan — main account" />
            </div>
            <div>
              <label htmlFor="stmt">Statement file (CSV)</label>
              <input id="stmt" type="file" accept=".csv,text/csv" onChange={readFile} />
            </div>
          </div>

          {header.length > 0 && (
            <>
              <div className="section-title">Which column holds what</div>
              <p className="muted" style={{ margin: '0 0 8px', fontSize: 13 }}>
                Every bank exports different headings, so this is asked once per bank.
              </p>
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px,1fr))' }}>
                {([
                  ['valueDate', 'Date *'],
                  ['credit', 'Credit amount *'],
                  ['narration', 'Narration'],
                  ['reference', 'Reference'],
                  ['counterparty', 'Payer name'],
                ] as const).map(([key, label]) => (
                  <div key={key}>
                    <label htmlFor={`col-${key}`}>{label}</label>
                    <select id={`col-${key}`} value={cols[key]} onChange={(e) => setCols((c) => ({ ...c, [key]: e.target.value }))}>
                      <option value="">—</option>
                      {header.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                ))}
              </div>

              <div className="row" style={{ gap: 8 }}>
                <button className="ghost" disabled={!ready || busy} onClick={() => void run(false)}>
                  {busy ? 'Reading…' : 'Preview'}
                </button>
                <button disabled={!ready || busy || !result} onClick={() => void run(true)}>
                  Import {result ? `${result.parsed} lines` : ''}
                </button>
                <button className="ghost" onClick={() => { setOpen(false); setResult(null); }}>Cancel</button>
              </div>
            </>
          )}
        </div>
      )}

      {result && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <span className="badge">{result.parsed} credit lines</span>
            <span className="badge ok">{result.matched} matched</span>
            <span className="badge warn">{result.unexplained} unmatched</span>
            {result.committed && (
              <span className="muted" style={{ fontSize: 13 }}>
                {result.stored} stored{result.parsed - (result.stored ?? 0) > 0 && ` · ${result.parsed - (result.stored ?? 0)} already seen`}
              </span>
            )}
          </div>
          {/* Already-seen lines are the normal case, not an error: accountants re-download
              overlapping ranges every day, and the fingerprint is what makes that safe. */}
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr><th>Date</th><th>Amount</th><th>Narration</th><th>Match</th></tr>
              </thead>
              <tbody>
                {result.rows.slice(0, 50).map((r, i) => (
                  <tr key={i}>
                    <td>{new Date(r.valueDate).toLocaleDateString('en-GB')}</td>
                    <td className="money">{rs(r.amount)}</td>
                    <td style={{ maxWidth: 320 }}>{r.narration || <span className="muted">—</span>}</td>
                    <td>
                      {r.match
                        ? <span className={`badge ${TIER[r.match.confidence]?.tone ?? ''}`}>{r.match.reason}</span>
                        : <span className="muted">no claim matches this</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {unexplained && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="section-title">Money we can&apos;t explain — last 60 days</div>
          {/* The most valuable output, and the one nobody asks for: somebody paid and never told the
              school, and that child may be sitting on a defaulter list. */}
          {unexplained.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>Every credit on file is accounted for.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead><tr><th>Date</th><th>Amount</th><th>Payer</th><th>Narration</th><th>Bank</th></tr></thead>
                <tbody>
                  {unexplained.map((u) => (
                    <tr key={u.id}>
                      <td>{new Date(u.valueDate).toLocaleDateString('en-GB')}</td>
                      <td className="money">{rs(u.amount)}</td>
                      <td>{u.counterparty ?? <span className="muted">—</span>}</td>
                      <td style={{ maxWidth: 300 }}>{u.narration}</td>
                      <td className="muted">{u.bankLabel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
