'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, type PortalPerformance, type PortalResult, type PortalTermResult } from '@sw/api-client';
import { Metric } from '@/components/metric';
import { monthKeyLabel } from '@sw/ui';

/**
 * My Results — two clearly separate things, because they ARE two things.
 *
 * **Term results** are the school's official exams and the report card they produce. Tap a term for the whole
 * picture: every subject's marks, total, percentage and grade. **Class tests** are the quizzes and tests a
 * teacher sets during the term. Mixing them (the old page did) made a Friday quiz look like part of the Term 1
 * result, and put an empty "no test marks" card above the one result the student actually had.
 *
 * ⚠️ **No class average, and a rank only for a podium finish.** A child seeing "17th of 20" is a pressure
 * device, not feedback; "you finished in the top three" is recognition. The API sends `null` for everyone else,
 * so this page could not show a lower rank even by mistake.
 */
type Tab = 'terms' | 'tests';

const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n * 10) / 10}%`);
const ORDINAL = { 1: '1st', 2: '2nd', 3: '3rd' } as const;
const tone = (p: number | null) => (p === null ? '' : p < 50 ? 'bad' : p < 60 ? 'warn' : 'ok');
const dmy = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function Seg<K extends string>({ tabs, value, onChange, label }: { tabs: Array<{ key: K; label: string }>; value: K; onChange: (k: K) => void; label: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (e: KeyboardEvent, i: number) => {
    const next = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].key);
    refs.current[next]?.focus();
  };
  return (
    <div className="seg" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button key={t.key} type="button" role="tab" ref={(el) => { refs.current[i] = el; }} aria-selected={value === t.key}
          tabIndex={value === t.key ? 0 : -1} onClick={() => onChange(t.key)} onKeyDown={(e) => move(e, i)}>{t.label}</button>
      ))}
    </div>
  );
}

export default function MyResults() {
  const [perf, setPerf] = useState<PortalPerformance | null>(null);
  const [cards, setCards] = useState<PortalResult[] | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [subjectTab, setSubjectTab] = useState<string | null>(null);
  const [openTerm, setOpenTerm] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const pushed = useRef(false);

  useEffect(() => {
    Promise.all([api.parentPortal.performance(), api.parentPortal.results()])
      .then(([p, r]) => {
        setPerf(p);
        setCards(r);
        setSubjectTab(p.subjects[0]?.subjectId ?? null);
        const fromUrl = new URLSearchParams(window.location.search).get('term');
        if (fromUrl && r.some((c) => c.termId === fromUrl)) { setOpenTerm(fromUrl); setTab('terms'); }
        else setTab(r.length > 0 ? 'terms' : 'tests');
      })
      .catch(() => setErr(true));
  }, []);

  // The browser's Back button closes an open term, like any other screen.
  useEffect(() => {
    const onPop = () => setOpenTerm(new URLSearchParams(window.location.search).get('term'));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const open = useCallback((termId: string) => {
    window.history.pushState(null, '', `/results?term=${termId}`);
    pushed.current = true;
    setOpenTerm(termId);
    window.scrollTo({ top: 0 });
  }, []);
  const close = useCallback(() => {
    if (pushed.current) { pushed.current = false; window.history.back(); return; }
    window.history.replaceState(null, '', '/results');
    setOpenTerm(null);
  }, []);

  if (err) return <p className="error">Couldn&apos;t load your results.</p>;
  if (!perf || !cards || !tab) return <span className="muted">Loading…</span>;

  if (openTerm) return <TermDetail termId={openTerm} onBack={close} />;

  const subject = perf.subjects.find((s) => s.subjectId === subjectTab) ?? null;

  return (
    <div className="stack">
      <h1>My Results</h1>
      <Seg tabs={[{ key: 'terms', label: 'Term results' }, { key: 'tests', label: 'Class tests' }]} value={tab} onChange={setTab} label="Kind of result" />

      {tab === 'terms' && (
        cards.length === 0 ? (
          <div className="card stack" style={{ gap: 6 }}>
            <strong>No term results yet</strong>
            <span className="muted">Your results appear here, subject by subject, once the school publishes them at the end of a term.</span>
          </div>
        ) : (
          <div className="stack">
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>Tap a term to see every subject.</p>
            {cards.map((c) => (
              <button key={c.termId} type="button" className="term-card" onClick={() => open(c.termId)} aria-label={`${c.term}, ${pct(c.overallPercent)}, grade ${c.grade}. Open the full result`}>
                <div style={{ flex: 1, minWidth: 0 }} className="stack">
                  <div className="row" style={{ gap: 8, justifyContent: 'flex-start', flexWrap: 'wrap' }}>
                    <span className="t">{c.term}</span>
                    <span className={`badge ${tone(c.overallPercent)}`}>Grade {c.grade}</span>
                    {c.sectionRank && <span className="badge ok">{ORDINAL[c.sectionRank]} in your section</span>}
                  </div>
                  <span className="bar" aria-hidden><span className={c.overallPercent < 50 ? 'low' : ''} style={{ width: `${Math.min(100, c.overallPercent)}%` }} /></span>
                </div>
                <span className="pct">{pct(c.overallPercent)}</span>
                <span className="go" aria-hidden>›</span>
              </button>
            ))}
          </div>
        )
      )}

      {tab === 'tests' && (
        perf.subjects.length === 0 ? (
          <div className="card stack" style={{ gap: 6 }}>
            <strong>No class tests yet</strong>
            <span className="muted">Tests and quizzes your teachers set during the term appear here, subject by subject, as soon as they record your marks.</span>
          </div>
        ) : (
          <>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>Tests and quizzes your teachers set during the term. Your official term result is under Term results.</p>
            <div className="grid">
              <Metric label="Overall average" value={perf.overall.percent == null ? '—' : pct(perf.overall.percent)} />
              <Metric label="Tests taken" value={perf.overall.testsTaken} />
              <Metric label="Tests missed" value={perf.overall.testsMissed} />
            </div>

            <div className="chips">
              {perf.subjects.map((s) => (
                <button key={s.subjectId} className={`chip ${subjectTab === s.subjectId ? 'active' : ''}`} onClick={() => setSubjectTab(s.subjectId)}>
                  {s.subjectName}
                  <span className="muted" style={{ fontSize: 11 }}> · {pct(s.summary.percent)}</span>
                </button>
              ))}
            </div>

            {subject && (
              <div className="card stack">
                <div className="row">
                  <strong style={{ fontSize: 16 }}>{subject.subjectName}</strong>
                  <span className="muted" style={{ fontSize: 13 }}>
                    {subject.summary.testsTaken} test{subject.summary.testsTaken === 1 ? '' : 's'} ·{' '}
                    {subject.summary.percent == null ? 'no marks yet' : `${pct(subject.summary.percent)} average`}
                    {subject.summary.testsMissed > 0 && ` · ${subject.summary.testsMissed} missed`}
                  </span>
                </div>

                {subject.monthly.length > 0 && (
                  <div className="stack" style={{ gap: 4 }}>
                    <span className="muted" style={{ fontSize: 12 }}>Month by month</span>
                    {subject.monthly.map((m) => (
                      <div key={m.month} className="row" style={{ gap: 10 }}>
                        <span style={{ minWidth: 78, fontSize: 13 }}>{monthKeyLabel(m.month)}</span>
                        <span className="bar" style={{ flex: 1, maxWidth: 220 }}><span className={(m.percent ?? 0) < 40 ? 'low' : ''} style={{ width: `${m.percent ?? 0}%` }} /></span>
                        <span style={{ fontSize: 13, minWidth: 42 }}>{pct(m.percent)}</span>
                        <span className="muted" style={{ fontSize: 12 }}>{m.testsTaken} test{m.testsTaken === 1 ? '' : 's'}</span>
                      </div>
                    ))}
                  </div>
                )}

                <table className="stacked">
                  <thead><tr><th>Test</th><th>Date</th><th>Marks</th><th>%</th></tr></thead>
                  <tbody>
                    {subject.tests.map((t) => {
                      const p = t.isAbsent || t.marksObtained == null ? null : (t.marksObtained / t.totalMarks) * 100;
                      return (
                        <tr key={t.id}>
                          <td data-label="Test">{t.name}</td>
                          <td data-label="Date">{dmy(t.testDate)}</td>
                          <td data-label="Marks">{t.isAbsent ? <span className="badge warn">absent</span> : `${t.marksObtained ?? '—'} / ${t.totalMarks}`}</td>
                          <td data-label="Percent">{pct(p)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}

// ── One term, in full ────────────────────────────────────────────────────────

function TermDetail({ termId, onBack }: { termId: string; onBack: () => void }) {
  const [d, setD] = useState<PortalTermResult | null>(null);
  const [err, setErr] = useState(false);
  const [fileErr, setFileErr] = useState(false);

  useEffect(() => {
    let alive = true;
    setD(null); setErr(false);
    api.parentPortal.termResult(termId).then((r) => { if (alive) setD(r); }).catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [termId]);

  async function download() {
    setFileErr(false);
    try { window.open((await api.parentPortal.termResultFile(termId)).url, '_blank', 'noopener'); } catch { setFileErr(true); }
  }

  const back = <button type="button" className="ghost small" onClick={onBack} style={{ alignSelf: 'flex-start' }}>← All results</button>;
  if (err) return <div className="stack">{back}<p className="error">Couldn&apos;t load this result.</p></div>;
  if (!d) return <div className="stack">{back}<span className="muted">Loading…</span></div>;

  const multi = d.exams.length > 1;

  return (
    <div className="stack">
      {back}
      <h1>{d.term}</h1>

      <div className="card stack" style={{ gap: 12 }}>
        <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <div className="muted" style={{ fontSize: 13 }}>Overall result</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 36, fontWeight: 800, color: 'var(--brand)', lineHeight: 1.1 }}>{pct(d.overallPercent)}</div>
            <div className="muted" style={{ fontSize: 13 }}>{d.totalObtained} of {d.totalMarks} marks</div>
          </div>
          <div className="chips" style={{ justifyContent: 'flex-end' }}>
            <span className={`badge ${tone(d.overallPercent)}`} style={{ fontSize: 14, padding: '4px 12px' }}>Grade {d.grade}</span>
            {d.rank && <span className="badge ok" style={{ fontSize: 14, padding: '4px 12px' }}>{ORDINAL[d.rank]} in your section</span>}
          </div>
        </div>
        <span className="bar" aria-hidden><span className={d.overallPercent < 50 ? 'low' : ''} style={{ width: `${Math.min(100, d.overallPercent)}%` }} /></span>
        {d.hasFile && (
          <div>
            <button type="button" className="ghost small" onClick={download}>Download report card</button>
            {fileErr && <span className="error" style={{ marginLeft: 8 }}>Couldn&apos;t open the file.</span>}
          </div>
        )}
      </div>

      <div className="card stack" style={{ gap: 10 }}>
        <strong style={{ fontSize: 15 }}>Subject by subject</strong>
        <table className="stacked">
          <thead><tr><th>Subject</th><th>Marks</th><th>Out of</th><th>Percent</th><th>Grade</th></tr></thead>
          <tbody>
            {d.subjects.map((s) => (
              <tr key={s.subject}>
                <td data-label="Subject"><strong style={{ fontWeight: 600 }}>{s.subject}</strong></td>
                <td data-label="Marks">{s.absent ? <span className="badge warn">Absent</span> : s.marksObtained ?? '—'}</td>
                <td data-label="Out of">{s.totalMarks}</td>
                <td data-label="Percent">{pct(s.percent)}</td>
                <td data-label="Grade">{s.grade ? <span className={`badge ${tone(s.percent)}`}>{s.grade}</span> : '—'}</td>
              </tr>
            ))}
            <tr>
              <td data-label="Subject"><strong>Total</strong></td>
              <td data-label="Marks"><strong>{d.totalObtained}</strong></td>
              <td data-label="Out of"><strong>{d.totalMarks}</strong></td>
              <td data-label="Percent"><strong>{pct(d.overallPercent)}</strong></td>
              <td data-label="Grade"><span className={`badge ${tone(d.overallPercent)}`}>{d.grade}</span></td>
            </tr>
          </tbody>
        </table>
        {multi && <span className="muted" style={{ fontSize: 12 }}>The percentage combines your exams by their weight in the term, so it can differ slightly from marks ÷ out of.</span>}
      </div>

      {multi && (
        <div className="stack" style={{ gap: 8 }}>
          <strong style={{ fontSize: 15 }}>Exam by exam</strong>
          {d.exams.map((e) => (
            <details key={e.id} className="card">
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                {e.name} <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {dmy(e.examDate)} · {e.weightagePercent}% of the term · {pct(e.percent)}</span>
              </summary>
              <table className="stacked" style={{ marginTop: 10 }}>
                <thead><tr><th>Subject</th><th>Marks</th><th>Out of</th><th>Percent</th><th>Grade</th></tr></thead>
                <tbody>
                  {e.subjects.map((s) => (
                    <tr key={s.subject}>
                      <td data-label="Subject">{s.subject}</td>
                      <td data-label="Marks">{s.isAbsent ? <span className="badge warn">Absent</span> : s.marksObtained ?? '—'}</td>
                      <td data-label="Out of">{s.totalMarks}</td>
                      <td data-label="Percent">{pct(s.percent)}</td>
                      <td data-label="Grade">{s.grade ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ))}
        </div>
      )}

      {d.gradeScale.length > 0 && (
        <details className="card">
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>How grades work</summary>
          <div className="chips" style={{ marginTop: 10 }}>
            {d.gradeScale.map((b) => (
              <span key={b.label} className="badge">{b.label}: {Math.floor(b.minPercent)}–{Math.floor(b.maxPercent)}%</span>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
