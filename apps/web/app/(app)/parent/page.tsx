'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type ParentChild } from '@/lib/api';

export default function ParentHome() {
  const [children, setChildren] = useState<ParentChild[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => { api.parent.children().then(setChildren).catch(() => setErr(true)); }, []);

  if (err) return <p className="error">Couldn&apos;t load your children.</p>;
  if (!children) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      <h1>My Children</h1>
      {children.length === 0 ? (
        <div className="card"><p className="muted" style={{ margin: 0 }}>No children are linked to your account yet. Please contact the school office.</p></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px,1fr))', gap: 14 }}>
          {children.map((c) => (
            <div key={c.studentId} className="card stack">
              <div className="row">
                <div>
                  <div style={{ fontWeight: 600, fontSize: 16 }}>{c.fullName}</div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {c.className ? `${c.className} — ${c.sectionName}` : 'Not enrolled'}{c.rollNumber != null ? ` · Roll ${c.rollNumber}` : ''}
                  </div>
                </div>
                {c.isPrimary && <span className="badge ok">primary</span>}
              </div>
              <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="metric"><div className="value">{c.attendancePercent == null ? '—' : `${c.attendancePercent}%`}</div><div className="label">Attendance</div></div>
                <div className="metric"><div className="value">Rs {c.outstandingFees.toLocaleString()}</div><div className="label">Outstanding</div></div>
              </div>
              <div className="row" style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                <Link className="chip" href={`/parent/${c.studentId}`}>Overview</Link>
                <Link className="chip" href={`/parent/${c.studentId}/attendance`}>Attendance</Link>
                <Link className="chip" href={`/parent/${c.studentId}/results`}>Results</Link>
                <Link className="chip" href={`/parent/${c.studentId}/fees`}>Fees</Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
