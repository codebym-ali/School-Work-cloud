'use client';

import { useEffect, useState } from 'react';
import { api, type PortalPerformance, type PortalResult } from '@/lib/api';
import { monthKeyLabel } from '@/lib/format';

/**
 * My Results — class tests by subject, plus published report cards.
 *
 * Tests come first because they are the recent, actionable feedback; a report card arrives once
 * a term. Deliberately NO class average and NO rank anywhere on this page: a child seeing "24th
 * of 30" is a pressure device, not feedback. Their own month-on-month trend is what they can act
 * on, and comparison stays on the staff side.
 */
export default function MyResults() {
  const [perf, setPerf] = useState<PortalPerformance | null>(null);
  const [cards, setCards] = useState<PortalResult[] | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    Promise.all([api.portal.performance(), api.portal.results()])
      .then(([p, r]) => {
        setPerf(p);
        setCards(r);
        setTab(p.subjects[0]?.subjectId ?? null);
      })
      .catch(() => setErr(true));
  }, []);

  if (err) return <p className="error">Couldn&apos;t load your results.</p>;
  if (!perf || !cards) return <p className="muted">Loading…</p>;

  const subject = perf.subjects.find((s) => s.subjectId === tab) ?? null;

  return (
    <div className="stack">
      <h1>My Results</h1>

      {perf.subjects.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>No test marks yet. They&apos;ll appear here subject by subject once your teachers record them.</p>
        </div>
      ) : (
        <>
          <div className="grid">
            <div className="metric">
              <div className="value">{perf.overall.percent == null ? '—' : `${perf.overall.percent}%`}</div>
              <div className="label">Overall average</div>
            </div>
            <div className="metric">
              <div className="value">{perf.overall.testsTaken}</div>
              <div className="label">Tests taken</div>
            </div>
            <div className="metric">
              <div className="value">{perf.overall.testsMissed}</div>
              <div className="label">Tests missed</div>
            </div>
          </div>

          {/* One tab per subject the student actually has marks in. */}
          <div className="chips">
            {perf.subjects.map((s) => (
              <button key={s.subjectId} className={`chip ${tab === s.subjectId ? 'active' : ''}`} onClick={() => setTab(s.subjectId)}>
                {s.subjectName}
                <span className="muted" style={{ fontSize: 11 }}> · {s.summary.percent == null ? '—' : `${s.summary.percent}%`}</span>
              </button>
            ))}
          </div>

          {subject && (
            <div className="card stack">
              <div className="row">
                <strong style={{ fontSize: 16 }}>{subject.subjectName}</strong>
                <span className="muted" style={{ fontSize: 13 }}>
                  {subject.summary.testsTaken} test{subject.summary.testsTaken === 1 ? '' : 's'} ·{' '}
                  {subject.summary.percent == null ? 'no marks yet' : `${subject.summary.percent}% average`}
                  {subject.summary.testsMissed > 0 && ` · ${subject.summary.testsMissed} missed`}
                </span>
              </div>

              {subject.monthly.length > 0 && (
                <div className="stack" style={{ gap: 4 }}>
                  <span className="muted" style={{ fontSize: 12 }}>Month by month</span>
                  {subject.monthly.map((m) => (
                    <div key={m.month} className="row" style={{ gap: 10 }}>
                      <span style={{ minWidth: 78, fontSize: 13 }}>{monthKeyLabel(m.month)}</span>
                      {/* A bar reads faster than a number when the point is the direction of travel. */}
                      <span style={{ flex: 1, maxWidth: 220, background: '#e5e7eb', borderRadius: 999, height: 8 }}>
                        <span style={{
                          display: 'block', height: 8, borderRadius: 999,
                          width: `${m.percent ?? 0}%`,
                          background: (m.percent ?? 0) >= 40 ? '#3355cc' : '#b91c1c',
                        }} />
                      </span>
                      <span style={{ fontSize: 13, minWidth: 42 }}>{m.percent == null ? '—' : `${m.percent}%`}</span>
                      <span className="muted" style={{ fontSize: 12 }}>{m.testsTaken} test{m.testsTaken === 1 ? '' : 's'}</span>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead><tr><th>Test</th><th>Date</th><th>Marks</th><th>%</th></tr></thead>
                  <tbody>
                    {subject.tests.map((t) => {
                      const pct = t.isAbsent || t.marksObtained == null ? null : Math.round((t.marksObtained / t.totalMarks) * 100);
                      return (
                        <tr key={t.id}>
                          <td>{t.name}</td>
                          <td>{new Date(t.testDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                          <td>
                            {t.isAbsent
                              ? <span className="badge warn">absent</span>
                              : `${t.marksObtained ?? '—'} / ${t.totalMarks}`}
                          </td>
                          <td>{pct == null ? '—' : `${pct}%`}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      <div className="card stack">
        <strong style={{ fontSize: 15 }}>Report cards</strong>
        <table>
          <thead><tr><th>Term</th><th>Overall</th><th>Grade</th><th>Section rank</th></tr></thead>
          <tbody>
            {cards.map((r, i) => (
              <tr key={i}>
                <td>{r.term}</td>
                <td>{r.overallPercent}%</td>
                <td>{r.grade}</td>
                <td>{r.sectionRank ?? '—'}</td>
              </tr>
            ))}
            {cards.length === 0 && <tr><td colSpan={4} className="muted">No published results yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
