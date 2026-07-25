'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet, apiPost, ApiError, type AcademicYear, type Campus, type Klass, type Section } from '@/lib/api';
import { useMe } from '@/lib/me-context';

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
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function reload() {
    const [y, c, k, s] = await Promise.all([
      apiGet<AcademicYear[]>('/academic-years'),
      apiGet<Campus[]>('/campuses'),
      apiGet<Klass[]>('/classes'),
      apiGet<Section[]>('/sections'),
    ]);
    setYears(y); setCampuses(c); setClasses(k); setSections(s);
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

  return (
    <div className="stack">
      <div className="stack" style={{ gap: 4 }}>
        <h1 style={{ marginBottom: 0 }}>School setup</h1>
        <p className="muted" style={{ margin: 0 }}>
          Three things to set up before you can admit students. Do them in order — each one needs the one above it.
        </p>
      </div>

      {loaded && <SetupProgress done={done} nextStep={nextStep} />}
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
          onCreate={(b) => run(() => apiPost('/campuses', b), 'Campus added')} />
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
        title="Classes & sections"
        blurb="Each class sits in a campus and is split into sections. Students are admitted into a section."
        state={hasClass && hasSection ? 'done' : 'todo'}
        openByDefault={nextStep === 3 || nextStep === 0}
        lockedReason={!hasCampus ? 'Add a campus first — a class has to belong to one.' : undefined}
        count={hasClass ? `${classes.length} class${classes.length === 1 ? '' : 'es'} · ${sections.length} section${sections.length === 1 ? '' : 's'}` : undefined}
      >
        <ClassesStep classes={classes} sections={sections} campuses={myCampuses}
          onCreateClass={(b) => run(() => apiPost('/classes', b), 'Class added')}
          onCreateSections={(classId, names) =>
            run(() => Promise.all(names.map((name) => apiPost('/sections', { classId, name }))),
              names.length === 1 ? 'Section added' : `${names.length} sections added`)} />
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

function CampusStep({ campuses, isOwner, onCreate }: { campuses: Campus[]; isOwner: boolean; onCreate: (b: object) => void }) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');

  return (
    <>
      {campuses.length === 0
        ? <p className="muted" style={{ margin: 0, fontSize: 13 }}>No campuses yet. Most schools start with one — you can add more later.</p>
        : (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {campuses.map((c) => <span key={c.id} className="badge">{c.name}</span>)}
          </div>
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

/** Classes and sections are one job, not two — a class without sections can't take a
 *  student, so sections are added inline on the class they belong to rather than from a
 *  separate card with its own class dropdown. */
function ClassesStep({ classes, sections, campuses, onCreateClass, onCreateSections }: {
  classes: Klass[]; sections: Section[]; campuses: Campus[];
  onCreateClass: (b: object) => void;
  onCreateSections: (classId: string, names: string[]) => void;
}) {
  const router = useRouter();
  const [campusId, setCampusId] = useState('');
  const [name, setName] = useState('');

  const targetCampus = campusId || (campuses.length === 1 ? campuses[0].id : '');

  // "Order" decides the sort position of a class. It's a developer concept, so we assign
  // it automatically (next number in that campus) instead of asking a school admin for it.
  const nextOrder = (cid: string) => {
    const inCampus = classes.filter((k) => k.campusId === cid);
    return inCampus.length ? Math.max(...inCampus.map((k) => k.order)) + 1 : 1;
  };

  const groups = campuses
    .map((c) => ({ id: c.id, campus: c.name, items: classes.filter((k) => k.campusId === c.id).sort((a, b) => a.order - b.order) }))
    .filter((g) => g.items.length > 0);

  return (
    <>
      {classes.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          No classes yet. Add your first class below — for example “Nursery”, “Grade 1” or “9th”.
        </p>
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          {groups.map((g) => (
            <div key={g.id} className="stack" style={{ gap: 8 }}>
              {campuses.length > 1 && (
                <div className="muted" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  {g.campus}
                </div>
              )}
              {g.items.map((k) => (
                <ClassRow key={k.id} klass={k}
                  sections={sections.filter((s) => s.classId === k.id).sort((a, b) => a.name.localeCompare(b.name))}
                  onAddSections={(names) => onCreateSections(k.id, names)}
                  onOpenStudents={(sectionId) => {
                    const qs = new URLSearchParams({ campusId: k.campusId, classId: k.id });
                    if (sectionId) qs.set('sectionId', sectionId);
                    router.push(`/students?${qs.toString()}`);
                  }} />
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="inline-form">
        {campuses.length > 1 && (
          <div><label>Campus</label>
            <select value={campusId} onChange={(e) => setCampusId(e.target.value)}>
              <option value="">Select…</option>
              {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <div><label>Class name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="9th" /></div>
        <button
          disabled={!name.trim() || !targetCampus}
          onClick={() => { onCreateClass({ campusId: targetCampus, name: name.trim(), order: nextOrder(targetCampus) }); setName(''); }}
        >
          Add class
        </button>
      </div>
    </>
  );
}

function ClassRow({ klass, sections, onAddSections, onOpenStudents }: {
  klass: Klass; sections: Section[];
  onAddSections: (names: string[]) => void;
  onOpenStudents: (sectionId?: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState('');

  // Accepts "A" or "A, B, C" — adding sections one at a time is the most repetitive part
  // of setting up a school, so one field takes the whole list.
  const parsed = Array.from(new Set(input.split(',').map((s) => s.trim()).filter(Boolean)));

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 12px' }} className="stack">
      <div className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ minWidth: 70 }}>{klass.name}</strong>
        {sections.length ? (
          sections.map((s) => (
            <button key={s.id} className="badge" style={{ border: 'none', cursor: 'pointer' }}
              title={`View students in ${klass.name} · Section ${s.name}`}
              onClick={() => onOpenStudents(s.id)}>
              Section {s.name}
            </button>
          ))
        ) : (
          <span className="badge" style={{ background: '#fef3c7', color: '#92400e' }}>Needs a section before students can be admitted</span>
        )}
        <div className="row" style={{ gap: 8, marginLeft: 'auto' }}>
          <button className="ghost small" onClick={() => setAdding((v) => !v)}>{adding ? 'Cancel' : '+ Section'}</button>
          <button className="ghost small" onClick={() => onOpenStudents()}>View students</button>
        </div>
      </div>
      {adding && (
        <div className="inline-form" style={{ marginTop: 4 }}>
          <div style={{ flex: 1 }}>
            <label>Section name{parsed.length > 1 ? 's' : ''}</label>
            <input autoFocus value={input} onChange={(e) => setInput(e.target.value)} placeholder="A, B, C" />
          </div>
          <button disabled={!parsed.length} onClick={() => { onAddSections(parsed); setInput(''); setAdding(false); }}>
            {parsed.length > 1 ? `Add ${parsed.length} sections` : 'Add section'}
          </button>
        </div>
      )}
    </div>
  );
}
