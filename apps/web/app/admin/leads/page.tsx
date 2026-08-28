'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { platformApi, type Lead, type LeadStatus } from '@/lib/platform-api';
import { usePlatformMe } from '../me-context';

const STATUSES: LeadStatus[] = ['NEW', 'CONTACTED', 'CONVERTED', 'CLOSED'];

/**
 * Leads inbox (SA8) — demo/contact requests captured from the public marketing site. A customer-facing
 * function, so SUPER_ADMIN + SUPPORT only (the API 403s everyone else, and the nav link is hidden).
 * Work each lead through the pipeline: new → contacted → converted / closed.
 */
export default function LeadsPage() {
  const me = usePlatformMe();
  const canWork = me.role === 'SUPER_ADMIN' || me.role === 'SUPPORT';
  const [leads, setLeads] = useState<Lead[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setLeads((await platformApi.leads({ status: filter || undefined, pageSize: 100 })).data); }
    finally { setLoading(false); }
  }, [filter]);
  useEffect(() => { if (canWork) load().catch(() => {}); else setLoading(false); }, [canWork, load]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); await load(); setMsg({ ok: true, text: ok }); }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed' }); }
  }

  if (!canWork) {
    return (
      <div className="stack">
        <h1 style={{ margin: 0 }}>Leads</h1>
        <div className="toast err">Only Super Admin or Support can view leads.</div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row">
        <h1 style={{ margin: 0 }}>Leads <span className="muted" style={{ fontWeight: 400, fontSize: 15 }}>({leads.length})</span></h1>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        Demo &amp; contact requests from the marketing site. Work them through the pipeline: new → contacted → converted / closed.
      </p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <div className="inline-form">
        <div><label>Filter status</label>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter leads by status">
            <option value="">All</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <table>
        <thead><tr><th>Received</th><th>Name / school</th><th>Contact</th><th>Students</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {leads.map((l) => (
            <tr key={l.id}>
              <td className="muted" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{new Date(l.createdAt).toLocaleDateString()}</td>
              <td>
                {l.name}
                {l.schoolName && <div className="muted" style={{ fontSize: 13 }}>{l.schoolName}</div>}
                {l.message && <div className="muted" style={{ fontSize: 12, marginTop: 4, maxWidth: 320 }}>&ldquo;{l.message}&rdquo;</div>}
                {l.note && <div style={{ fontSize: 12, marginTop: 4, color: 'var(--accent-ink)' }}>Note: {l.note}</div>}
              </td>
              <td style={{ fontSize: 13 }}>
                <a href={`mailto:${l.email}`}>{l.email}</a>
                {l.phone && <div className="muted">{l.phone}</div>}
              </td>
              <td>{l.studentCount ?? <span className="muted">—</span>}</td>
              <td>
                <select value={l.status} aria-label={`Status for ${l.name}`}
                  onChange={(e) => run(() => platformApi.updateLead(l.id, { status: e.target.value as LeadStatus }), `${l.name} → ${e.target.value}`)}>
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </td>
              <td>
                <button className="ghost small" onClick={() => {
                  const note = window.prompt('Internal note for this lead:', l.note ?? '');
                  if (note !== null) run(() => platformApi.updateLead(l.id, { note }), 'Note saved');
                }}>Note</button>
              </td>
            </tr>
          ))}
          {leads.length === 0 && <tr><td colSpan={6} className="muted">{loading ? 'Loading…' : 'No leads yet.'}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
