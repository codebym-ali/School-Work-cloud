'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type SmsLog, type SmsTemplate } from '@/lib/api';
import { useMe } from '@/lib/me-context';
import { isSchoolWideAdmin } from '@/lib/roles';
import { Metric } from '@/components/metric';

/**
 * SMS & notifications (§14).
 *
 * ⚠️ **The product texts real parents — fee reminders, absence alerts, results — and until now there
 * was no screen for any of it.** The templates could only be changed by a developer writing to the
 * database, the credit balance was invisible, and what had actually been sent to whom was unknowable.
 * A school running on SMS could not see its own SMS. This is the visibility surface: the effective
 * templates, the balance, and the log with its failures.
 *
 * Editing a template is OWNER-only (it changes what every parent receives); reading is open to a
 * campus admin. The API is the authority — this only shapes what is offered.
 */
const TRIGGER_LABELS: Record<string, string> = {
  FEE_REMINDER: 'Fee reminder',
  FEE_RECEIPT: 'Fee receipt',
  ABSENCE: 'Absence alert',
  RESULT_READY: 'Result ready',
  LEAVE_STATUS: 'Leave decision',
  ACCOUNT_INVITE: 'Account invite',
  MANUAL: 'Manual message',
};

const STATUS_TONE: Record<string, string> = {
  DELIVERED: 'ok', SENT: 'ok', QUEUED: 'warn', FAILED: 'err',
};

export default function SmsPage() {
  const me = useMe();
  const canEditTemplates = isSchoolWideAdmin(me?.roles);

  const [templates, setTemplates] = useState<SmsTemplate[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [logs, setLogs] = useState<SmsLog[]>([]);
  const [logStatus, setLogStatus] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadLogs = (status = logStatus) =>
    api.sms.logs({ status: status || undefined }).then((r) => setLogs(r.data)).catch(() => {});

  useEffect(() => {
    api.sms.templates().then(setTemplates).catch(() => setMsg({ ok: false, text: 'Could not load templates.' }));
    api.sms.credits().then((c) => setBalance(c.balance)).catch(() => {});
    loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveTemplate(triggerKey: string) {
    setBusy(true);
    setMsg(null);
    try {
      await api.sms.saveTemplate(triggerKey, draft);
      setTemplates(await api.sms.templates());
      setEditing(null);
      setMsg({ ok: true, text: 'Template saved. New messages of this kind use it from now on.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not save the template.' });
    } finally { setBusy(false); }
  }

  async function retry(id: string) {
    setMsg(null);
    try { await api.sms.retry(id); setMsg({ ok: true, text: 'Re-queued.' }); await loadLogs(); }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not re-queue.' }); }
  }

  const failed = logs.filter((l) => l.status === 'FAILED').length;

  return (
    <div className="stack">
      <h1>SMS &amp; notifications</h1>
      <p className="muted" style={{ margin: 0 }}>
        What the school texts parents — the templates behind each alert, the credit balance, and every
        message that has gone out. Editing a template changes what every parent receives next.
      </p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <div className="grid">
        <Metric label="Credit balance" value={balance == null ? '—' : balance.toLocaleString()}
          alert={balance != null && balance < 100} />
        <Metric label="Templates" value={templates.length} />
        <Metric label="Recent failures" value={failed} alert={failed > 0} />
      </div>

      <div className="card stack" style={{ gap: 8 }}>
        <div className="section-title" style={{ margin: 0 }}>Templates</div>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Placeholders in {'{curly braces}'} are filled in when the message is sent.
          {!canEditTemplates && ' Only the school owner or an operations admin can change these.'}
        </p>
        <table>
          <thead>
            <tr><th style={{ width: 160 }}>Sent when</th><th>Message</th>{canEditTemplates && <th style={{ width: 90 }} />}</tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.triggerKey}>
                <td><strong>{TRIGGER_LABELS[t.triggerKey] ?? t.triggerKey}</strong></td>
                <td>
                  {editing === t.triggerKey ? (
                    <textarea style={{ width: '100%', minHeight: 60 }} value={draft} maxLength={1000}
                      onChange={(e) => setDraft(e.target.value)} />
                  ) : (
                    <span className="muted" style={{ fontSize: 13 }}>
                      {t.body || <em>Empty — nothing is sent.</em>}
                    </span>
                  )}
                </td>
                {canEditTemplates && (
                  <td>
                    {editing === t.triggerKey ? (
                      <div className="chips">
                        <button className="small" disabled={busy} onClick={() => saveTemplate(t.triggerKey)}>Save</button>
                        <button className="ghost small" onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    ) : (
                      <button className="ghost small" onClick={() => { setEditing(t.triggerKey); setDraft(t.body); }}>Edit</button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card stack" style={{ gap: 8 }}>
        <div className="row">
          <div className="section-title" style={{ margin: 0 }}>Sent messages</div>
          <select value={logStatus} onChange={(e) => { setLogStatus(e.target.value); loadLogs(e.target.value); }}>
            <option value="">All statuses</option>
            <option value="QUEUED">Queued</option>
            <option value="SENT">Sent</option>
            <option value="DELIVERED">Delivered</option>
            <option value="FAILED">Failed</option>
          </select>
        </div>
        {logs.length === 0 ? (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Nothing sent{logStatus ? ' with that status' : ' yet'}.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr><th>When</th><th>To</th><th>Kind</th><th>Status</th><th>Message</th><th /></tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{new Date(l.createdAt).toLocaleString()}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{l.recipient}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{TRIGGER_LABELS[l.templateKey] ?? l.templateKey}</td>
                    <td>
                      <span className={`badge ${STATUS_TONE[l.status] ?? ''}`}>{l.status}</span>
                      {l.status === 'FAILED' && l.failReason && (
                        <div className="muted" style={{ fontSize: 11 }}>{l.failReason}</div>
                      )}
                    </td>
                    <td className="muted" style={{ fontSize: 12, maxWidth: 320 }}>{l.message}</td>
                    <td>{l.status === 'FAILED' && <button className="ghost small" onClick={() => retry(l.id)}>Retry</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
