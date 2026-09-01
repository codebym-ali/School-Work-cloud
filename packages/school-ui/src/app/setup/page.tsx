'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, apiGet, apiPost, ApiError, type AcademicYear, type Campus, type Klass, type Section, type Subject } from '@sw/api-client';
import { useMe } from '@sw/session';
import { isSchoolWideAdmin } from '@sw/roles';
import { ConfirmDialog } from '../classes/confirm-dialog';
import { subjectCatalogueFrom } from '@school/lib/subject-match';

/** Setup is a one-time, ordered job: campuses → school year → classes → sections.
 *  Each step is only useful once the one above it exists, so the page presents them
 *  as numbered steps and tells you which one to do next rather than showing three
 *  equal-looking cards the reader has to sequence themselves. */
export default function SetupPage() {
  const me = useMe();
  const canConfigure = isSchoolWideAdmin(me?.roles);
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [classes, setClasses] = useState<Klass[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Subjects are read (not managed) here — step 3 reports whether every class can take a
  // student, which is false until each has both a section AND a subject.
  async function reload() {
    const [y, c, k, s, sub] = await Promise.all([
      apiGet<AcademicYear[]>('/academic-years'),
      apiGet<Campus[]>('/campuses'),
      apiGet<Klass[]>('/classes'),
      apiGet<Section[]>('/sections'),
      api.subjects.listAll().catch(() => [] as Subject[]),
    ]);
    setYears(y); setCampuses(c); setClasses(k); setSections(s); setSubjects(sub);
  }
  useEffect(() => { reload().catch(() => {}).finally(() => setLoaded(true)); }, []);

  async function run(fn: () => Promise<unknown>, ok: string): Promise<string | null> {
    try {
      await fn();
      await reload();
      setMsg({ ok: true, text: ok });
      return null;
    } catch (e) {
      const text = e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';
      setMsg({ ok: false, text });
      return text;
    }
  }

  // A campus-bound admin only works within their own campus (the API force-scopes anyway).
  const myCampuses = canConfigure ? campuses : campuses.filter((c) => c.id === me?.campusId);

  const hasCampus = myCampuses.length > 0;
  const hasYear = years.some((y) => y.isCurrent);
  const hasClass = classes.length > 0;
  // A class can only take a student once it has both a section and a subject, so the step is
  // only "done" when every class does — a single unfinished class must not read as complete.
  const blockers = classes
    .map((k) => ({
      name: k.name,
      needsSection: !sections.some((s) => s.classId === k.id),
      needsSubjects: !subjects.some((s) => s.classId === k.id),
    }))
    .filter((b) => b.needsSection || b.needsSubjects);
  const classesReady = hasClass && blockers.length === 0;
  const done = [hasCampus, hasYear, classesReady].filter(Boolean).length;

  // The first unfinished step is the one we open and point the reader at.
  const nextStep = !hasCampus ? 1 : !hasYear ? 2 : !classesReady ? 3 : 0;
  const setupComplete = nextStep === 0;
  // Distinct NAMES, not rows: a subject taught in three classes is one subject to a reader.
  const distinctSubjects = subjectCatalogueFrom(subjects).length;

  return (
    <div className="stack">
      <div className="stack" style={{ gap: 4 }}>
        <h1 style={{ marginBottom: 0 }}>School configuration</h1>
        <p className="muted" style={{ margin: 0 }}>
          {setupComplete
            ? 'Your campuses, school years and class structure. Students, fees and results are recorded against these.'
            : 'Three things to set up before you can admit students. Do them in order — each one needs the one above it.'}
        </p>
      </div>

      {loaded && !setupComplete && <SetupProgress done={done} nextStep={nextStep} />}
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {!loaded ? (
        <div className="card"><p className="muted" style={{ margin: 0 }}>Loading your school…</p></div>
      ) : (
      <>
      <Step
        n={1}
        title="Campuses"
        blurb="The physical branches of your school. Every class belongs to one."
        state={hasCampus ? 'done' : 'todo'}
        openByDefault={nextStep === 1}
        count={hasCampus ? `${myCampuses.length} campus${myCampuses.length === 1 ? '' : 'es'}` : undefined}
      >
        <CampusStep campuses={myCampuses} canConfigure={canConfigure}
          onCreate={(b) => run(() => apiPost('/campuses', b), 'Campus added')}
          onUpdate={(id, body) => run(() => api.campuses.update(id, body), 'Campus updated')}
          onDelete={(id) => run(() => api.campuses.remove(id), 'Campus deleted')} />
      </Step>

      <Step
        n={2}
        title="School year"
        blurb="The year that admissions, fees and report cards are recorded against."
        state={hasYear ? 'done' : 'todo'}
        openByDefault={nextStep === 2}
        count={hasYear ? years.find((y) => y.isCurrent)?.name : undefined}
      >
        <YearStep years={years} canConfigure={canConfigure}
          onCreate={(b) => run(() => apiPost('/academic-years', b), 'School year added')}
          onSetCurrent={(id) => run(() => apiPost(`/academic-years/${id}/set-current`), 'Current year updated')} />
      </Step>

      <Step
        n={3}
        title="Classes, sections & subjects"
        blurb="Each class sits in a campus and teaches a set of subjects. A section is one classroom group with a fixed number of seats — students are admitted into a section."
        state={classesReady ? 'done' : 'todo'}
        openByDefault={nextStep === 3 || nextStep === 0}
        lockedReason={!hasCampus ? 'Add a campus first — a class has to belong to one.' : undefined}
        count={hasClass ? `${classes.length} class${classes.length === 1 ? '' : 'es'} · ${sections.length} section${sections.length === 1 ? '' : 's'} · ${distinctSubjects} subject${distinctSubjects === 1 ? '' : 's'}` : undefined}
      >
        {/* Setup states WHETHER the class structure is ready and sends you to the one screen
            that manages it. It used to embed the whole class manager here as well, so classes
            had two homes with two sets of handlers — and `/classes/[id]` then linked back to
            Setup, which by this point only linked forward again. */}
        <div className="stack" style={{ gap: 10 }}>
          {blockers.length > 0 && (
            <div className="toast warn">
              {blockers.length} class{blockers.length === 1 ? '' : 'es'} cannot take students yet:{' '}
              {blockers.map((b) => `${b.name} (${b.needsSection && b.needsSubjects ? 'no section or subjects' : b.needsSection ? 'no section' : 'no subjects'})`).join(', ')}.
            </div>
          )}
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {hasClass
              ? `${classes.length} class${classes.length === 1 ? '' : 'es'} and ${sections.length} section${sections.length === 1 ? '' : 's'} are set up. Classes, sections, subjects and teachers are all managed on the Classes screen.`
              : 'No classes yet. Add them on the Classes screen — each one needs at least one section and one subject before a student can be admitted into it.'}
          </p>
          <div>
            <Link className="chip" href="/classes">
              📚 {hasClass ? 'Manage classes & sections →' : 'Add your first class →'}
            </Link>
          </div>
        </div>
      </Step>
      </>
      )}
    </div>
  );
}

/** Where you are in the three steps, so the page has an obvious starting point. */
function SetupProgress({ done, nextStep }: { done: number; nextStep: number }) {
  const labels = ['Campuses', 'School year', 'Classes & sections'];
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row" style={{ alignItems: 'center', gap: 10 }}>
        <strong style={{ fontSize: 15 }}>{done} of 3 done</strong>
        {nextStep === 0
          ? <span className="badge ok">Setup complete — you can admit students</span>
          : <span className="muted" style={{ fontSize: 13 }}>Next: step {nextStep} · {labels[nextStep - 1]}</span>}
      </div>
      <div className="row" style={{ gap: 6 }}>
        {labels.map((l, i) => (
          <div key={l} style={{ flex: 1, height: 6, borderRadius: 999, background: i < done ? '#16a34a' : '#e5e7eb' }} title={l} />
        ))}
      </div>
    </div>
  );
}

/** A numbered, collapsible step. Collapsed steps show a one-line summary so the page
 *  reads as a short checklist instead of three long forms stacked on top of each other. */
function Step({ n, title, blurb, state, count, openByDefault, lockedReason, children }: {
  n: number; title: string; blurb: string; state: 'done' | 'todo'; count?: string;
  openByDefault: boolean; lockedReason?: string; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(openByDefault);
  const touched = useRef(false);
  useEffect(() => { if (!touched.current) setOpen(openByDefault); }, [openByDefault]);
  const locked = Boolean(lockedReason);

  return (
    <div className="card stack" style={{ gap: 12, opacity: locked ? 0.65 : 1 }}>
      <div
        className="row"
        onClick={() => { if (!locked) { touched.current = true; setOpen((v) => !v); } }}
        style={{ alignItems: 'flex-start', gap: 12, cursor: locked ? 'default' : 'pointer' }}
      >
        <div style={{
          flex: '0 0 28px', height: 28, borderRadius: 999, display: 'grid', placeItems: 'center',
          fontSize: 13, fontWeight: 700,
          background: state === 'done' ? '#16a34a' : '#e5e7eb', color: state === 'done' ? '#fff' : '#374151',
        }}>
          {state === 'done' ? '✓' : n}
        </div>
        <div className="stack" style={{ gap: 2, flex: 1 }}>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2>
            {count && <span className="muted" style={{ fontSize: 12 }}>{count}</span>}
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>{lockedReason ?? blurb}</p>
        </div>
        {!locked && <span className="muted" style={{ fontSize: 12 }}>{open ? 'Hide' : 'Open'}</span>}
      </div>
      {open && !locked && <div className="stack" style={{ gap: 12 }}>{children}</div>}
    </div>
  );
}

function CampusStep({ campuses, canConfigure, onCreate, onUpdate, onDelete }: {
  campuses: Campus[]; canConfigure: boolean;
  onCreate: (b: object) => void;
  onUpdate: (id: string, body: { name?: string; address?: string }) => void;
  onDelete: (id: string) => Promise<string | null> | void;
}) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string; address: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Campus | null>(null);

  return (
    <>
      {campuses.length === 0
        ? <p className="muted" style={{ margin: 0, fontSize: 13 }}>No campuses yet. Most schools start with one — you can add more later.</p>
        : (
          <div className="stack" style={{ gap: 6 }}>
            {campuses.map((c) => (
              <div key={c.id} className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8 }}>
                {editing?.id === c.id ? (
                  <div className="inline-form" style={{ flex: 1 }}>
                    <div style={{ minWidth: 160 }}>
                      <label>Campus name</label>
                      <input autoFocus value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                    </div>
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <label>Address</label>
                      <input value={editing.address} onChange={(e) => setEditing({ ...editing, address: e.target.value })} />
                    </div>
                    <button disabled={!editing.name.trim()}
                      onClick={() => { onUpdate(editing.id, { name: editing.name.trim(), address: editing.address.trim() }); setEditing(null); }}>
                      Save
                    </button>
                    <button className="ghost" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                ) : (
                  <>
                    <strong>{c.name}</strong>
                    {c.address && <span className="muted" style={{ fontSize: 13 }}>{c.address}</span>}
                    {canConfigure && (
                      <div className="row" style={{ gap: 8, marginLeft: 'auto' }}>
                        <button className="ghost small" onClick={() => setEditing({ id: c.id, name: c.name, address: c.address ?? '' })}>Rename</button>
                        <button className="ghost small" style={{ color: '#b91c1c' }}
                          onClick={() => setPendingDelete(c)}>
                          Delete
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      {canConfigure && campuses.length > 0 && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Staff logins for each campus are managed in <Link href="/campuses" style={{ fontWeight: 600 }}>Campus Hub</Link>.
        </p>
      )}
      {pendingDelete && (
        <ConfirmDialog
          title={`Delete campus “${pendingDelete.name}”?`}
          body="Deleting is blocked while classes, users, inquiries, vacancies or applications belong to this campus."
          confirmLabel="Delete campus"
          onConfirm={() => onDelete(pendingDelete.id)}
          onClose={() => setPendingDelete(null)} />
      )}
      {canConfigure ? (
        <div className="inline-form">
          <div><label>Campus name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Main Campus" /></div>
          <div style={{ flex: 1 }}><label>Address (optional)</label><input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, city" /></div>
          <button disabled={!name.trim()} onClick={() => { onCreate({ name: name.trim(), address: address.trim() || undefined }); setName(''); setAddress(''); }}>
            Add campus
          </button>
        </div>
      ) : (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Campuses are managed by the school owner.</p>
      )}
    </>
  );
}

function YearStep({ years, canConfigure, onCreate, onSetCurrent }: { years: AcademicYear[]; canConfigure: boolean; onCreate: (b: object) => void; onSetCurrent: (id: string) => void }) {
  const thisYear = new Date().getFullYear();
  const [name, setName] = useState(`${thisYear}-${String((thisYear + 1) % 100).padStart(2, '0')}`);
  const [startDate, setStart] = useState(`${thisYear}-04-01`);
  const [endDate, setEnd] = useState(`${thisYear + 1}-03-31`);

  return (
    <>
      {years.length === 0
        ? <p className="muted" style={{ margin: 0, fontSize: 13 }}>No school year yet. Add the year you are currently teaching.</p>
        : (
          <table>
            <thead><tr><th>Year</th><th>Status</th>{canConfigure && <th></th>}</tr></thead>
            <tbody>
              {years.map((y) => (
                <tr key={y.id}>
                  <td>{y.name}</td>
                  <td>{y.isCurrent ? <span className="badge ok">In progress</span> : <span className="muted">Past year</span>}</td>
                  {canConfigure && <td>{!y.isCurrent && <button className="ghost small" onClick={() => onSetCurrent(y.id)}>Make this the current year</button>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      {canConfigure ? (
        <div className="inline-form">
          <div><label>Year name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="2026-27" /></div>
          <div><label>First day</label><input type="date" value={startDate} onChange={(e) => setStart(e.target.value)} /></div>
          <div><label>Last day</label><input type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} /></div>
          <button disabled={!name.trim()} onClick={() => onCreate({ name: name.trim(), startDate, endDate, isCurrent: true })}>Add school year</button>
        </div>
      ) : (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>School years are managed by the school owner.</p>
      )}
    </>
  );
}
