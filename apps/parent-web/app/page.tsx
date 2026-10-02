'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { api, type PortalOverview } from '@sw/api-client';
import { MetricLink } from '@/components/metric';
import { STUDENT_STATUS, statusStyle } from '@sw/ui';

type DetailTab = 'academic' | 'personal' | 'guardians';

const TABS: Array<{ key: DetailTab; label: string }> = [
  { key: 'academic', label: 'Academic' },
  { key: 'personal', label: 'Personal' },
  { key: 'guardians', label: 'Guardians' },
];

export default function ParentHome() {
  const [data, setData] = useState<PortalOverview | null>(null);
  const [err, setErr] = useState(false);
  const [tab, setTab] = useState<DetailTab>('academic');

  const load = () => { setData(null); setErr(false); api.parentPortal.overview().then(setData).catch(() => setErr(true)); };
  useEffect(() => { load(); }, []);
  useEffect(() => { const h = () => load(); window.addEventListener('child-switched', h); return () => window.removeEventListener('child-switched', h); }, []);

  if (err) return <div className="container"><p className="error">Couldn&apos;t load your dashboard. Please try refreshing.</p></div>;
  if (!data) return <div className="container"><p className="muted">Loading…</p></div>;
  const s = data.student;

  return (
    <div className="stack">
      {/* Profile hero */}
      <div className="card">
        <div className="profile-hero">
          {s.photoUrl ? (
            <img src={s.photoUrl} alt={s.fullName} className="profile-photo" />
          ) : (
            <span className="profile-photo--fallback">{initials(s.fullName)}</span>
          )}
          <div className="profile-info">
            <h1>{s.fullName}</h1>
            <p className="profile-class">
              {data.enrollment
                ? `${data.enrollment.className} — ${data.enrollment.sectionName}`
                : 'Not enrolled'}
              {data.enrollment?.rollNumber ? ` · Roll #${data.enrollment.rollNumber}` : ''}
            </p>
            <div className="profile-badges">
              <span className="badge">{s.grNumber}</span>
              {data.enrollment && <span className="badge">{data.enrollment.year}</span>}
              {data.enrollment?.campusName && <span className="badge">{data.enrollment.campusName}</span>}
              {s.status !== 'ACTIVE' && (
                <span className={`badge ${s.status === 'SUSPENDED' ? 'warn' : 'bad'}`}>
                  {STUDENT_STATUS[s.status]?.label ?? s.status}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {s.status !== 'ACTIVE' && (
        <div className="card stack" style={{ ...statusStyle(s.status), gap: 6 }}>
          <strong>Status: {STUDENT_STATUS[s.status]?.label ?? s.status}</strong>
          {s.status === 'SUSPENDED' && (
            <span>
              Suspended{s.statusEndsOn ? ` until ${new Date(s.statusEndsOn).toLocaleDateString()}` : ''}.
              Please contact the school office.
            </span>
          )}
          {s.statusReason && <span style={{ fontSize: 13 }}>Reason: {s.statusReason}</span>}
        </div>
      )}

      {/* Quick stats */}
      <div className="grid">
        <MetricLink label="Attendance" href="/attendance"
          value={data.attendancePercent == null ? '—' : `${data.attendancePercent}%`} />
        <MetricLink label="Outstanding fees" href="/fees"
          alert={data.outstandingFees > 0}
          value={`Rs ${data.outstandingFees.toLocaleString()}`} />
        <MetricLink label="Report cards" href="/results"
          value={data.reportCards || '0'} />
      </div>

      {/* Tabbed details */}
      <div className="card stack">
        <div className="detail-tabs" role="tablist" aria-label="Details">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
              tabIndex={tab === t.key ? 0 : -1} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>

        {tab === 'academic' && (
          <div className="detail-grid">
            <Field label="GR number" value={s.grNumber} />
            <Field label="Class" value={data.enrollment ? `${data.enrollment.className} — ${data.enrollment.sectionName}` : '—'} />
            <Field label="Roll number" value={data.enrollment?.rollNumber ?? '—'} />
            <Field label="Academic year" value={data.enrollment?.year ?? '—'} />
            <Field label="Campus" value={data.enrollment?.campusName ?? '—'} />
            <Field label="Admission date" value={data.enrollment?.admissionDate ? new Date(data.enrollment.admissionDate).toLocaleDateString() : '—'} />
          </div>
        )}

        {tab === 'personal' && (
          <div className="detail-grid">
            <Field label="Gender" value={s.gender} />
            <Field label="Date of birth" value={new Date(s.dateOfBirth).toLocaleDateString()} />
            <Field label="Religion" value={s.religion ?? '—'} />
            <Field label="Blood group" value={s.bloodGroup ?? '—'} />
            <Field label="Address" value={[s.addressLine, s.city].filter(Boolean).join(', ') || '—'} />
            {s.medicalNotes && <Field label="Medical notes" value={s.medicalNotes} />}
          </div>
        )}

        {tab === 'guardians' && (
          <div className="stack" style={{ gap: 10 }}>
            {data.guardians.length === 0 && <p className="muted">No guardians on file.</p>}
            {data.guardians.map((g, i) => (
              <div key={i} className="card" style={{ padding: 14 }}>
                <div className="row" style={{ marginBottom: 8 }}>
                  <strong>{g.name}</strong>
                  <div className="chips">
                    <span className="badge">{g.relation}</span>
                    {g.isPrimary && <span className="badge ok">Primary</span>}
                  </div>
                </div>
                <div className="detail-grid">
                  <Field label="Phone" value={g.phone} />
                  {g.email && <Field label="Email" value={g.email} />}
                  {g.occupation && <Field label="Occupation" value={g.occupation} />}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="detail-field">
      <div className="detail-label">{label}</div>
      <div className="detail-value">{value}</div>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : (parts[0]?.[0] ?? '').toUpperCase();
}
