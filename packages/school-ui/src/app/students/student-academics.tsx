'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  api, PERFORMANCE_RANGES, RANGE_LABEL,
  type AttendanceDayStatus, type PerformanceRange, type StudentAttendanceSummary, type StudentPerformance, type StudentTermResult,
} from '@sw/api-client';
import { ProfileTabs } from './profile-tabs';

/**
 * The student's academic record on their profile: attendance, class tests, term exams.
 *
 * ⚠️ **Class tests and term exams are two different things and are kept on two different tabs.** A class test is
 * the teacher's own (`ClassTest`, any day, any weight); a term exam is the school's official `ExamDefinition`
 * that feeds the report card. Mixing them made a Friday quiz look like part of the Term 1 result.
 *
 * Attendance numbers come from the server (`/students/:id/attendance-summary`) — the percentage rule lives in one
 * place, so this never disagrees with the Students list, and the school calendar is folded in so "not marked"
 * and "school was closed" look different.
 */
export type AcademicsTab = 'attendance' | 'tests' | 'terms';
type Load<T> = { state: 'loading' } | { state: 'error' } | { state: 'ready'; data: T };

const TABS: Array<{ key: AcademicsTab; label: string }> = [
  { key: 'attendance', label: 'Attendance' },
  { key: 'tests', label: 'Class tests' },
  { key: 'terms', label: 'Term exams' },
];

const toneFor = (v: number | null | undefined) => (v === null || v === undefined ? '' : v < 50 ? 'is-bad' : v < 60 ? 'is-warn' : 'is-ok');
const attTone = (v: number | null) => (v === null ? '' : v < 75 ? 'is-bad' : v < 85 ? 'is-warn' : 'is-ok');
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v)}%`);
const dmy = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function useLoad<T>(fetcher: (() => Promise<T>) | null, key: string): Load<T> {
  const [s, setS] = useState<Load<T>>({ state: 'loading' });
  useEffect(() => {
    if (!fetcher) return;
    let alive = true;
    setS({ state: 'loading' });
    fetcher().then((data) => { if (alive) setS({ state: 'ready', data }); }).catch(() => { if (alive) setS({ state: 'error' }); });
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return s;
}

export function StudentAcademics({ studentId, tab, onTab }: { studentId: string; tab: AcademicsTab; onTab: (t: AcademicsTab) => void }) {
  return (
    <div className="card stack" style={{ gap: 14 }}>
      {/* The arrow turns when a subject opens — a bare <summary> in a grid shows no marker, so nothing said it was clickable. */}
      <style>{'.sw-chev{display:inline-block;transition:transform .15s;color:var(--muted)}details[open]>summary .sw-chev{transform:rotate(90deg)}'}</style>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Academics</h2>
        <ProfileTabs tabs={TABS} value={tab} onChange={onTab} label="Academic record" />
      </div>
      {tab === 'attendance' && <AttendanceTab studentId={studentId} />}
      {tab === 'tests' && <ClassTestsTab studentId={studentId} />}
      {tab === 'terms' && <TermExamsTab studentId={studentId} />}
    </div>
  );
}

function Status({ load, empty, children }: { load: Load<unknown>; empty?: string | null; children: React.ReactNode }) {
  if (load.state === 'loading') return <span className="ov-skel" style={{ height: 120, display: 'block' }} />;
  if (load.state === 'error') return <p className="muted" style={{ margin: 0 }}>Could not load this. Try again in a moment.</p>;
  if (empty) return <p className="muted" style={{ margin: 0, fontSize: 13 }}>{empty}</p>;
  return <>{children}</>;
}

// ── Attendance ───────────────────────────────────────────────────────────────

const DAY: Record<AttendanceDayStatus, { bg: string; border?: string; word: string }> = {
  PRESENT: { bg: '#86d6a4', word: 'Present' },
  LATE: { bg: '#f3c969', word: 'Late' },
  HALF_DAY: { bg: '#f0a35e', word: 'Half day' },
  ON_LEAVE: { bg: '#a9b8d4', word: 'On leave' },
  ABSENT: { bg: '#e5736b', word: 'Absent' },
  UNMARKED: { bg: 'transparent', border: '1.5px dashed #9aa6b8', word: 'Register not taken' },
  CLOSED: { bg: '#e9edf3', word: 'School closed' },
};
const LEGEND: AttendanceDayStatus[] = ['PRESENT', 'LATE', 'HALF_DAY', 'ON_LEAVE', 'ABSENT', 'UNMARKED', 'CLOSED'];
const RANGES = [{ days: 30, label: '30 days' }, { days: 90, label: '90 days' }, { days: 0, label: 'This year' }];

function AttendanceTab({ studentId }: { studentId: string }) {
  const [days, setDays] = useState(90);
  const load = useLoad<StudentAttendanceSummary>(() => {
    if (days === 0) return api.studentAcademics.attendance(studentId);
    const to = new Date();
    return api.studentAcademics.attendance(studentId, new Date(to.getTime() - days * 86400000).toISOString().slice(0, 10), to.toISOString().slice(0, 10));
  }, `${studentId}:${days}`);

  const a = load.state === 'ready' ? load.data : null;
  const view = useMemo(() => {
    if (!a) return null;
    const byMonth = new Map<string, StudentAttendanceSummary['calendar']>();
    for (const d of a.calendar) byMonth.set(d.date.slice(0, 7), [...(byMonth.get(d.date.slice(0, 7)) ?? []), d]);
    return {
      rows: [...byMonth.entries()],
      recentAbsences: a.calendar.filter((d) => d.status === 'ABSENT').slice(-8).reverse(),
    };
  }, [a]);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div role="group" aria-label="Period" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {RANGES.map((r) => (
          <button key={r.days} type="button" className={`chip${days === r.days ? ' active' : ''}`} aria-pressed={days === r.days} onClick={() => setDays(r.days)}>{r.label}</button>
        ))}
      </div>
      <Status load={load} empty={a && a.markedDays === 0 && a.unmarkedDays === 0 ? 'No school days fall in this period.' : null}>
        {a && view && (
          <>
            <div className="ov-stats3">
              <div><span className="ov-stat-label">Attendance</span>
                <span className="ov-stat-value"><span className={`ov-num ${a.percent === null ? '' : a.percent < 75 ? 'is-bad' : a.percent < 85 ? 'is-warn' : ''}`}>{pct(a.percent)}</span></span>
                <span className="ov-sub">{a.markedDays} day{a.markedDays === 1 ? '' : 's'} marked</span></div>
              <div><span className="ov-stat-label">Absent</span>
                <span className="ov-stat-value"><span className={`ov-num ${a.counts.absent > 0 ? 'is-warn' : ''}`}>{a.counts.absent}</span></span>
                <span className="ov-sub">day{a.counts.absent === 1 ? '' : 's'}</span></div>
              <div><span className="ov-stat-label">Late · Leave</span>
                <span className="ov-stat-value"><span className="ov-num">{a.counts.late} · {a.counts.onLeave}</span></span>
                <span className="ov-sub">{a.counts.halfDay > 0 ? `${a.counts.halfDay} half day${a.counts.halfDay === 1 ? '' : 's'}` : 'days'}</span></div>
            </div>
            {a.unmarkedDays > 0 && (
              <p className="ov-warn-text" style={{ margin: 0, fontSize: 13 }}>
                The register was not taken on {a.unmarkedDays} school day{a.unmarkedDays === 1 ? '' : 's'} in this period, so the percentage covers marked days only.
              </p>
            )}

            <section>
              <h3 className="ov-h3">Day by day</h3>
              <div role="img" aria-label={`Attendance by day: ${a.counts.absent} absent, ${a.counts.late} late, ${a.counts.onLeave} on leave, ${a.unmarkedDays} school days with no register`}
                style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {view.rows.map(([month, cells]) => (
                  <div key={month} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className="ov-sub" style={{ width: 64, flex: 'none' }}>{new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })}</span>
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                      {cells.map((d) => {
                        const st = DAY[d.status];
                        return (
                          <span key={d.date} title={`${new Date(d.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })} · ${d.note ?? st.word}`}
                            style={{ width: 14, height: 14, borderRadius: 3, background: st.bg, border: st.border, display: 'inline-block', boxSizing: 'border-box' }} />
                        );
                      })}
                    </span>
                  </div>
                ))}
              </div>
              <div className="ov-sub" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10 }}>
                {LEGEND.map((s) => (
                  <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: DAY[s].bg, border: DAY[s].border, display: 'inline-block', boxSizing: 'border-box' }} />{DAY[s].word}
                  </span>
                ))}
              </div>
            </section>

            {a.months.length > 1 && (
              <section>
                <h3 className="ov-h3">By month</h3>
                <ul className="ov-bars">
                  {a.months.map((m) => (
                    <li key={m.month}>
                      <span>{new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</span>
                      <span className="ov-bar"><span className={`ov-bar-fill ${attTone(m.percent)}`} style={{ width: `${m.percent ?? 0}%` }} /></span>
                      <span className="ov-num">{pct(m.percent)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {view.recentAbsences.length > 0 && (
              <section>
                <h3 className="ov-h3">Recent absences</h3>
                <p className="ov-sub" style={{ margin: 0 }}>
                  {view.recentAbsences.map((d) => new Date(d.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })).join(' · ')}
                </p>
              </section>
            )}
          </>
        )}
      </Status>
    </div>
  );
}

// ── Class tests (teacher-created) ────────────────────────────────────────────

function ClassTestsTab({ studentId }: { studentId: string }) {
  const [range, setRange] = useState<PerformanceRange>('3m');
  const load = useLoad<StudentPerformance>(() => api.performance.forStudent(studentId, range), `${studentId}:${range}`);
  const p = load.state === 'ready' ? load.data : null;
  const empty = p && p.overall.testsTaken + p.overall.testsMissed === 0 ? 'No class tests have been given to this student in this period.' : null;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <p className="ov-sub" style={{ margin: 0 }}>Tests and quizzes your teachers set and mark during the term. Official term exams are on the next tab.</p>
      <div role="group" aria-label="Period" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {PERFORMANCE_RANGES.map((r) => (
          <button key={r} type="button" className={`chip${range === r ? ' active' : ''}`} aria-pressed={range === r} onClick={() => setRange(r)}>{RANGE_LABEL[r]}</button>
        ))}
      </div>
      <Status load={load} empty={empty}>
        {p && (
          <>
            <div className="ov-stats3">
              <div><span className="ov-stat-label">Average</span><span className="ov-stat-value"><span className={`ov-num ${p.overall.percent !== null && p.overall.percent < 50 ? 'is-bad' : p.overall.percent !== null && p.overall.percent < 60 ? 'is-warn' : ''}`}>{pct(p.overall.percent)}</span></span><span className="ov-sub">{p.overall.marksObtained} of {p.overall.marksTotal} marks</span></div>
              <div><span className="ov-stat-label">Tests taken</span><span className="ov-stat-value"><span className="ov-num">{p.overall.testsTaken}</span></span><span className="ov-sub">in {RANGE_LABEL[range].toLowerCase()}</span></div>
              <div><span className="ov-stat-label">Missed</span><span className="ov-stat-value"><span className={`ov-num ${p.overall.testsMissed > 0 ? 'is-warn' : ''}`}>{p.overall.testsMissed}</span></span><span className="ov-sub">absent on test day</span></div>
            </div>

            <section>
              <h3 className="ov-h3">By subject <span className="ov-sub">(weakest first — tap a subject to see its tests)</span></h3>
              <div className="stack" style={{ gap: 8 }}>
                {p.subjects.map((s) => (
                  <details key={s.subjectId} className="ov-bars" style={{ padding: '10px 16px' }}>
                    <summary style={{ cursor: 'pointer', display: 'grid', gridTemplateColumns: '14px minmax(90px, 32%) 1fr 48px', alignItems: 'center', gap: 10, listStyle: 'none' }}>
                      <span className="sw-chev" aria-hidden>▸</span>
                      <span>{s.subjectName}</span>
                      <span className="ov-bar"><span className={`ov-bar-fill ${toneFor(s.percent)}`} style={{ width: `${s.percent ?? 0}%` }} /></span>
                      <span className="ov-num" style={{ textAlign: 'right' }}>{pct(s.percent)}</span>
                    </summary>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ marginTop: 10, width: '100%' }}>
                        <thead><tr><th>Test</th><th>Date</th><th style={{ textAlign: 'right' }}>Marks</th><th style={{ textAlign: 'right' }}>%</th></tr></thead>
                        <tbody>
                          {[...s.tests].sort((a, b) => b.testDate.localeCompare(a.testDate)).map((t) => (
                            <tr key={t.id}>
                              <td>{t.name}</td>
                              <td>{dmy(t.testDate)}</td>
                              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{t.isAbsent ? <span className="badge warn">Absent</span> : `${t.marksObtained ?? '—'} / ${t.totalMarks}`}</td>
                              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{t.isAbsent || t.marksObtained === null ? '—' : pct((t.marksObtained / t.totalMarks) * 100)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                ))}
              </div>
            </section>
          </>
        )}
      </Status>
    </div>
  );
}

// ── Term exams (official, feed the report card) ──────────────────────────────

const EXAM_TYPE: Record<string, string> = { MONTHLY: 'Monthly', MID_TERM: 'Mid-term', FINAL: 'Final', SURPRISE_TEST: 'Surprise test' };
const EXAM_STATUS: Record<string, { word: string; cls: string }> = {
  PUBLISHED: { word: 'Published', cls: 'ok' },
  MARKS_ENTRY: { word: 'Marks being entered', cls: 'warn' },
  DRAFT: { word: 'Draft', cls: 'warn' },
};

function TermExamsTab({ studentId }: { studentId: string }) {
  const load = useLoad<StudentTermResult[]>(() => api.studentAcademics.termResults(studentId), studentId);
  const [fileError, setFileError] = useState<string | null>(null);
  const terms = load.state === 'ready' ? load.data : [];
  // Oldest → newest, only terms with a report card: a trend needs at least two points to mean anything.
  const trend = [...terms].filter((t) => t.reportCard).reverse();

  async function openReportCard(termId: string) {
    setFileError(null);
    try { window.open((await api.studentAcademics.reportCardFile(studentId, termId)).url, '_blank', 'noopener'); }
    catch { setFileError('Could not open that report card.'); }
  }

  return (
    <div className="stack" style={{ gap: 14 }}>
      <p className="ov-sub" style={{ margin: 0 }}>The school&rsquo;s official exams for each term — the marks behind the report card. Teachers&rsquo; own class tests are on the previous tab.</p>
      <Status load={load} empty={load.state === 'ready' && terms.length === 0 ? 'No term exam marks have been entered for this student yet.' : null}>
        {trend.length > 1 && (
          <section>
            <h3 className="ov-h3">Term by term</h3>
            <div className="ov-months" role="img" aria-label={`Overall result by term: ${trend.map((t) => `${t.term} ${Math.round(t.reportCard!.overallPercent)}%`).join(', ')}`}>
              {trend.map((t) => (
                <div key={t.termId} className="ov-month">
                  <span className="ov-month-val">{Math.round(t.reportCard!.overallPercent)}%</span>
                  <span className="ov-month-col"><span className={`ov-month-fill ${toneFor(t.reportCard!.overallPercent)}`} style={{ height: `${t.reportCard!.overallPercent}%` }} /></span>
                  <span className="ov-month-lbl">{t.term}</span>
                </div>
              ))}
            </div>
          </section>
        )}
        {fileError && <div className="toast err" role="alert">{fileError}</div>}
        {terms.map((t) => (
          <section key={t.termId} className="stack" style={{ gap: 10 }}>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <h3 className="ov-h3" style={{ margin: 0, fontSize: 15 }}>{t.term}</h3>
              {t.reportCard ? (
                <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span className="badge ok">{Math.round(t.reportCard.overallPercent)}% overall</span>
                  <span className="badge">Grade {t.reportCard.grade}</span>
                  {t.reportCard.sectionRank !== null && <span className="badge">Rank {t.reportCard.sectionRank} in section</span>}
                  {t.reportCard.hasFile && <button type="button" className="ghost small" onClick={() => openReportCard(t.termId)}>Download report card</button>}
                </span>
              ) : <span className="ov-sub">Report card not generated yet</span>}
            </div>
            {t.exams.map((e) => {
              const st = EXAM_STATUS[e.status] ?? { word: e.status, cls: '' };
              return (
                <div key={e.id} className="ov-bars" style={{ gap: 10 }}>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                    <span><strong>{e.name}</strong> <span className="ov-sub">{EXAM_TYPE[e.examType] ?? e.examType} · {dmy(e.examDate)} · counts {e.weightagePercent}% of the term</span></span>
                    <span className={`badge ${st.cls}`}>{st.word}</span>
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%' }}>
                      <thead><tr><th>Subject</th><th style={{ textAlign: 'right' }}>Marks</th><th style={{ textAlign: 'right' }}>%</th><th style={{ textAlign: 'right' }}>Grade</th><th style={{ textAlign: 'right' }}>Class avg</th></tr></thead>
                      <tbody>
                        {e.subjects.map((s) => {
                          const own = s.isAbsent || s.marksObtained === null ? null : (s.marksObtained / s.totalMarks) * 100;
                          return (
                            <tr key={s.subjectId}>
                              <td>{s.subject}</td>
                              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{s.isAbsent ? <span className="badge warn">Absent</span> : `${s.marksObtained ?? '—'} / ${s.totalMarks}`}</td>
                              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{pct(own)}</td>
                              <td style={{ textAlign: 'right' }}>{s.grade ?? '—'}</td>
                              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} title="Average of everyone in the class who sat this exam">
                                {pct(s.classAveragePercent)}
                                {own !== null && s.classAveragePercent !== null && (
                                  <span className="ov-sub" aria-label={own >= s.classAveragePercent ? 'at or above class average' : 'below class average'}> {own >= s.classAveragePercent ? '▲' : '▼'}</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                        <tr>
                          <td><strong>Total</strong></td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}><strong>{e.obtained} / {e.total}</strong></td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}><strong>{pct(e.percent)}</strong></td>
                          <td />
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}><strong>{pct(e.classAveragePercent)}</strong></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </section>
        ))}
      </Status>
    </div>
  );
}
