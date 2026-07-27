'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, apiGet, apiPost, ApiError, type AcademicYear, type Campus, type Klass, type Section, type Subject, type SubjectCatalogueEntry } from '@/lib/api';
import { useMe } from '@/lib/me-context';
import { ClassManager } from '../classes/class-manager';
import { subjectCatalogueFrom } from '@/lib/subject-match';

/** Setup is a one-time, ordered job: campuses → school year → classes → sections.
 *  Each step is only useful once the one above it exists, so the page presents them
 *  as numbered steps and tells you which one to do next rather than showing three
 *  equal-looking cards the reader has to sequence themselves. */
export default function SetupPage() {
  const me = useMe();
  const isOwner = (me?.roles ?? []).includes('OWNER_ADMIN');
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [classes, setClasses] = useState<Klass[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [catalogue, setCatalogue] = useState<SubjectCatalogueEntry[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function reload() {
    const [y, c, k, s, sub, cat] = await Promise.all([
      apiGet<AcademicYear[]>('/academic-years'),
      apiGet<Campus[]>('/campuses'),
      apiGet<Klass[]>('/classes'),
      apiGet<Section[]>('/sections'),
      api.subjects.listAll().catch(() => [] as Subject[]),
      api.subjects.catalogue().catch(() => [] as SubjectCatalogueEntry[]),
    ]);
    setYears(y); setCampuses(c); setClasses(k); setSections(s); setSubjects(sub); setCatalogue(cat);
  }
  useEffect(() => { reload().catch(() => {}).finally(() => setLoaded(true)); }, []);

  async function run(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); await reload(); setMsg({ ok: true, text: ok }); }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Something went wrong. Please try again.' }); }
  }

  // A campus-bound admin only works within their own campus (the API force-scopes anyway).
  const myCampuses = isOwner ? campuses : campuses.filter((c) => c.id === me?.campusId);

  const hasCampus = myCampuses.length > 0;
  const hasYear = years.some((y) => y.isCurrent);
  const hasClass = classes.length > 0;
  const hasSection = sections.length > 0;
  const done = [hasCampus, hasYear, hasClass && hasSection].filter(Boolean).length;

  // The first unfinished step is the one we open and point the reader at.
  const nextStep = !hasCampus ? 1 : !hasYear ? 2 : !(hasClass && hasSection) ? 3 : 0;
  const setupComplete = nextStep === 0;
  const derivedCatalogue = subjectCatalogueFrom(subjects);
  const distinctSubjects = derivedCatalogue.length;

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

      <Step
        n={1}
        title="Campuses"
        blurb="The physical branches of your school. Every class belongs to one."
        state={hasCampus ? 'done' : 'todo'}
        openByDefault={nextStep === 1}
        count={hasCampus ? `${myCampuses.length} campus${myCampuses.length === 1 ? '' : 'es'}` : undefined}
      >
        <CampusStep campuses={myCampuses} isOwner={isOwner}
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
        <YearStep years={years} isOwner={isOwner}
          onCreate={(b) => run(() => apiPost('/academic-years', b), 'School year added')}
          onSetCurrent={(id) => run(() => apiPost(`/academic-years/${id}/set-current`), 'Current year updated')} />
      </Step>

      <Step
        n={3}
        title="Classes, sections & subjects"
        blurb="Each class sits in a campus and teaches a set of subjects. A section is one classroom group with a fixed number of seats — students are admitted into a section."
        state={hasClass && hasSection ? 'done' : 'todo'}
        openByDefault={nextStep === 3 || nextStep === 0}
        lockedReason={!hasCampus ? 'Add a campus first — a class has to belong to one.' : undefined}
        count={hasClass ? `${classes.length} class${classes.length === 1 ? '' : 'es'} · ${sections.length} section${sections.length === 1 ? '' : 's'} · ${distinctSubjects} subject${distinctSubjects === 1 ? '' : 's'}` : undefined}
      >
        {setupComplete ? (
          <div className="stack" style={{ gap: 8 }}>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {classes.length} class{classes.length === 1 ? '' : 'es'} and {sections.length} section{sections.length === 1 ? '' : 's'} are set up.
              Classes, sections and subjects are managed on the Classes screen.
            </p>
            <div><Link className="chip" href="/classes">📚 Manage classes &amp; sections →</Link></div>
          </div>
        ) : (
        <ClassManager classes={classes} sections={sections} subjects={subjects} campuses={myCampuses}
          catalogue={catalogue.length ? catalogue : derivedCatalogue}
          onCreateClass={async (b) => {
            // Return the new class so the row can open its subject form straight away —
            // a class with no subjects is the next thing to fix, so we point at it.
            try {
              const created = await apiPost<Klass>('/classes', b);
              await reload();
              setMsg({ ok: true, text: 'Class added — now add its subjects' });
              return created.id;
            } catch (e) {
              setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not add the class' });
              return null;
            }
          }}
          onCreateSections={(classId, names, subjectChoice, capacity) =>
            run(
              () => Promise.all(names.map((name) => api.sections.create({ classId, name, capacity, ...subjectChoice }))),
              names.length === 1 ? 'Section added' : `${names.length} sections added`,
            )}
          onCreateSubjects={(classId, names) =>
            run(() => Promise.all(names.map((name) => api.subjects.create(classId, name))),
              names.length === 1 ? 'Subject added' : `${names.length} subjects added`)}
          onRenameClass={(id, name) => run(() => api.classes.rename(id, name), 'Class renamed')}
          onDeleteClass={(id) => run(() => api.classes.remove(id), 'Class deleted')}
          onUpdateSection={(id, body) => run(() => api.sections.update(id, body), 'Section updated')}
          onDeleteSection={(id) => run(() => api.sections.remove(id), 'Section deleted')}
          onDeleteSubject={(id) => run(() => api.subjects.remove(id), 'Subject deleted')}
          onCreateSubjectInline={async (classId, name) => {
            try {
              const created = await api.subjects.create(classId, name);
              await reload();
              return created;
            } catch (e) {
              setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not add that subject' });
              return null;
            }
          }} />
        )}
      </Step>
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
  useEffect(() => { setOpen(openByDefault); }, [openByDefault]);
  const locked = Boolean(lockedReason);

  return (
    <div className="card stack" style={{ gap: 12, opacity: locked ? 0.65 : 1 }}>
      <div
        className="row"
        onClick={() => !locked && setOpen((v) => !v)}
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

function CampusStep({ campuses, isOwner, onCreate, onUpdate, onDelete }: {
  campuses: Campus[]; isOwner: boolean;
  onCreate: (b: object) => void;
  onUpdate: (id: string, body: { name?: string; address?: string }) => void;
  onDelete: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string; address: string } | null>(null);

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
                    {isOwner && (
                      <div className="row" style={{ gap: 8, marginLeft: 'auto' }}>
                        <button className="ghost small" onClick={() => setEditing({ id: c.id, name: c.name, address: c.address ?? '' })}>Rename</button>
                        <button className="ghost small" style={{ color: '#b91c1c' }}
                          onClick={() => { if (confirm(`Delete campus "${c.name}"? This cannot be undone.`)) onDelete(c.id); }}>
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
      {isOwner && campuses.length > 0 && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Staff logins for each campus are managed in <Link href="/campuses" style={{ fontWeight: 600 }}>Campus Hub</Link>.
        </p>
      )}
      {isOwner ? (
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

function YearStep({ years, isOwner, onCreate, onSetCurrent }: { years: AcademicYear[]; isOwner: boolean; onCreate: (b: object) => void; onSetCurrent: (id: string) => void }) {
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
            <thead><tr><th>Year</th><th>Status</th>{isOwner && <th></th>}</tr></thead>
            <tbody>
              {years.map((y) => (
                <tr key={y.id}>
                  <td>{y.name}</td>
                  <td>{y.isCurrent ? <span className="badge ok">In progress</span> : <span className="muted">Past year</span>}</td>
                  {isOwner && <td>{!y.isCurrent && <button className="ghost small" onClick={() => onSetCurrent(y.id)}>Make this the current year</button>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      {isOwner ? (
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
