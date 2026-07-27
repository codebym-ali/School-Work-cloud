'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, apiGet, apiPost, ApiError, type AcademicYear, type Campus, type Klass, type Section, type Subject } from '@/lib/api';
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
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loaded, setLoaded] = useState(false);

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
        title="Classes, sections & subjects"
        blurb="Each class sits in a campus, is split into sections, and teaches a set of subjects. Students are admitted into a section."
        state={hasClass && hasSection ? 'done' : 'todo'}
        openByDefault={nextStep === 3 || nextStep === 0}
        lockedReason={!hasCampus ? 'Add a campus first — a class has to belong to one.' : undefined}
        count={hasClass ? `${classes.length} class${classes.length === 1 ? '' : 'es'} · ${sections.length} section${sections.length === 1 ? '' : 's'} · ${subjects.length} subject${subjects.length === 1 ? '' : 's'}` : undefined}
      >
        <ClassesStep classes={classes} sections={sections} subjects={subjects} campuses={myCampuses}
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
          onCreateSections={(classId, names, subjectChoice) =>
            run(
              () => Promise.all(names.map((name) => api.sections.create({ classId, name, ...subjectChoice }))),
              names.length === 1 ? 'Section added' : `${names.length} sections added`,
            )}
          onCreateSubjects={(classId, names) =>
            run(() => Promise.all(names.map((name) => api.subjects.create(classId, name))),
              names.length === 1 ? 'Subject added' : `${names.length} subjects added`)}
          onRenameClass={(id, name) => run(() => api.classes.rename(id, name), 'Class renamed')}
          onDeleteClass={(id) => run(() => api.classes.remove(id), 'Class deleted')}
          onRenameSection={(id, name) => run(() => api.sections.rename(id, name), 'Section renamed')}
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
          <div className="chips">
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
function ClassesStep({ classes, sections, subjects, campuses, onCreateClass, onCreateSections, onCreateSubjects, onCreateSubjectInline, onRenameClass, onDeleteClass, onRenameSection, onDeleteSection, onDeleteSubject }: {
  classes: Klass[]; sections: Section[]; subjects: Subject[]; campuses: Campus[];
  onCreateClass: (b: object) => Promise<string | null>;
  onCreateSections: (classId: string, names: string[], subjectChoice: SubjectChoice) => void;
  onCreateSubjects: (classId: string, names: string[]) => void;
  onCreateSubjectInline: (classId: string, name: string) => Promise<Subject | null>;
  onRenameClass: (id: string, name: string) => void;
  onDeleteClass: (id: string) => void;
  onRenameSection: (id: string, name: string) => void;
  onDeleteSection: (id: string) => void;
  onDeleteSubject: (id: string) => void;
}) {
  const router = useRouter();
  const [campusId, setCampusId] = useState('');
  const [name, setName] = useState('');
  // The class just created — its row opens on the subject form, because a brand-new class
  // has neither sections nor subjects and subjects are the part people can't find.
  const [justCreated, setJustCreated] = useState<string | null>(null);
  // 9th and 10th usually share most of their subjects — retyping them per class is the
  // most tedious part of setting up a school, so a new class can inherit an existing list.
  const [copyFromClass, setCopyFromClass] = useState('');

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
                  subjects={subjects.filter((s) => s.classId === k.id).sort((a, b) => a.name.localeCompare(b.name))}
                  openSubjectsOnMount={justCreated === k.id}
                  onAddSections={(names, choice) => onCreateSections(k.id, names, choice)}
                  onAddSubjects={(names) => onCreateSubjects(k.id, names)}
                  onCreateSubjectInline={(name) => onCreateSubjectInline(k.id, name)}
                  onRename={(name) => onRenameClass(k.id, name)}
                  onDelete={() => onDeleteClass(k.id)}
                  onRenameSection={onRenameSection}
                  onDeleteSection={onDeleteSection}
                  onDeleteSubject={onDeleteSubject}
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
        {classes.length > 0 && (
          <div><label>Copy subjects from</label>
            <select value={copyFromClass} onChange={(e) => setCopyFromClass(e.target.value)}>
              <option value="">Start with none</option>
              {classes.map((c) => {
                const n = subjects.filter((s) => s.classId === c.id).length;
                return <option key={c.id} value={c.id} disabled={n === 0}>{c.name}{n ? ` (${n} subjects)` : ' — no subjects'}</option>;
              })}
            </select>
          </div>
        )}
        <button
          disabled={!name.trim() || !targetCampus}
          onClick={async () => {
            const id = await onCreateClass({ campusId: targetCampus, name: name.trim(), order: nextOrder(targetCampus) });
            setName('');
            if (id && copyFromClass) {
              const names = subjects.filter((s) => s.classId === copyFromClass).map((s) => s.name);
              if (names.length) await onCreateSubjects(id, names);
            }
            setJustCreated(id);
          }}
        >
          Add class
        </button>
      </div>
    </>
  );
}

/** How a new section gets its subject list: copy a sibling's, pick explicitly, or (neither)
 *  inherit everything the class offers. */
export type SubjectChoice = { copySubjectsFromSectionId?: string; subjectIds?: string[] };

/** One class: its sections, its subjects, when it was created, and the controls to add more.
 *  Sections and subjects both accept a comma-separated list, because entering "A, B, C" or
 *  "Maths, Physics, Urdu" in one go is how a school actually thinks about them. */
function ClassRow({ klass, sections, subjects, openSubjectsOnMount, onAddSections, onAddSubjects, onCreateSubjectInline, onRename, onDelete, onRenameSection, onDeleteSection, onDeleteSubject, onOpenStudents }: {
  klass: Klass; sections: Section[]; subjects: Subject[]; openSubjectsOnMount?: boolean;
  onAddSections: (names: string[], choice: SubjectChoice) => void;
  onAddSubjects: (names: string[]) => void;
  onCreateSubjectInline: (name: string) => Promise<Subject | null>;
  onRename: (name: string) => void;
  onDelete: () => void;
  onRenameSection: (id: string, name: string) => void;
  onDeleteSection: (id: string) => void;
  onDeleteSubject: (id: string) => void;
  onOpenStudents: (sectionId?: string) => void;
}) {
  const [panel, setPanel] = useState<'section' | 'subject' | null>(openSubjectsOnMount ? 'subject' : null);
  const [input, setInput] = useState('');
  // Subject plan for the section(s) about to be created.
  const [mode, setMode] = useState<'same' | 'choose'>('same');
  const [copyFrom, setCopyFrom] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  // "Choose different subjects" often means a subject the CLASS doesn't offer yet
  // (8-B takes Biology, 8th has never listed it) — so it can be created right here.
  const [newSubject, setNewSubject] = useState('');
  const [addingSubject, setAddingSubject] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null); // class name draft, null = not renaming
  const router = useRouter();

  useEffect(() => { if (openSubjectsOnMount) setPanel('subject'); }, [openSubjectsOnMount]);

  const parsed = Array.from(new Set(input.split(',').map((s) => s.trim()).filter(Boolean)));
  const open = (which: 'section' | 'subject') => {
    setPanel(panel === which ? null : which);
    setInput('');
    setMode('same');
    setCopyFrom(sections[0]?.id ?? '');
    setPicked(subjects.map((s) => s.id));
  };
  const subjectNames = (ids: string[]) => subjects.filter((s) => ids.includes(s.id)).map((s) => s.name);

  /** Create a subject on the class from inside the section form, then tick it. Keeps the
   *  operator in one place instead of cancelling out to add it and starting over. */
  async function addSubjectInline() {
    const name = newSubject.trim();
    if (!name) return;
    const existing = subjects.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (existing) { setPicked((p) => (p.includes(existing.id) ? p : [...p, existing.id])); setNewSubject(''); return; }
    setAddingSubject(true);
    const created = await onCreateSubjectInline(name);
    if (created) { setPicked((p) => [...p, created.id]); setNewSubject(''); }
    setAddingSubject(false);
  }

  const created = klass.createdAt
    ? new Date(klass.createdAt).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
    : null;

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 12px' }} className="stack">
      <div className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {renaming === null ? (
          <>
            <strong style={{ minWidth: 70 }}>{klass.name}</strong>
            {created && <span className="muted" style={{ fontSize: 12 }}>Created {created}</span>}
          </>
        ) : (
          <div className="inline-form" style={{ flex: 1 }}>
            <div style={{ flex: 1, minWidth: 160 }}>
              <input autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && renaming.trim()) { onRename(renaming.trim()); setRenaming(null); }
                  if (e.key === 'Escape') setRenaming(null);
                }} />
            </div>
            <button type="button" disabled={!renaming.trim()} onClick={() => { onRename(renaming.trim()); setRenaming(null); }}>Save</button>
            <button className="ghost" type="button" onClick={() => setRenaming(null)}>Cancel</button>
          </div>
        )}
        {renaming === null && (
          <div className="row" style={{ gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
            <button className="ghost small" onClick={() => open('section')}>{panel === 'section' ? 'Cancel' : '+ Section'}</button>
            <button className="ghost small" onClick={() => open('subject')}>{panel === 'subject' ? 'Cancel' : '+ Subject'}</button>
            <button className="ghost small" onClick={() => setRenaming(klass.name)}>Rename</button>
            <button className="ghost small" onClick={() => router.push(`/classes/${klass.id}`)}>Teachers</button>
            <button className="ghost small" onClick={() => onOpenStudents()}>View students</button>
            {/* The server refuses while sections/fees/exams depend on it and says which. */}
            <button className="ghost small" style={{ color: '#b91c1c' }}
              onClick={() => { if (confirm(`Delete class "${klass.name}"? This cannot be undone.`)) onDelete(); }}>
              Delete
            </button>
          </div>
        )}
      </div>

      <div className="chips">
        <span className="muted" style={{ fontSize: 12, minWidth: 62 }}>Subjects</span>
        {subjects.length
          ? subjects.map((s) => (
              <span key={s.id} className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {s.name}
                <button type="button" aria-label={`Remove ${s.name}`} title={`Remove ${s.name}`}
                  style={{ background: 'none', border: 0, padding: 0, color: 'inherit', opacity: 0.6, cursor: 'pointer', fontSize: 12 }}
                  onClick={() => { if (confirm(`Remove subject "${s.name}" from ${klass.name}?`)) onDeleteSubject(s.id); }}>
                  ✕
                </button>
              </span>
            ))
          : <span className="muted" style={{ fontSize: 12 }}>None yet — add the subjects this class studies.</span>}
      </div>

      <div className="chips">
        <span className="muted" style={{ fontSize: 12, minWidth: 62 }}>Sections</span>
        {sections.length ? (
          sections.map((s) => {
            // Surface a section that studies a DIFFERENT set from the class catalogue —
            // otherwise an elective split is invisible on this screen.
            const own = s.subjectIds ?? [];
            const differs = own.length > 0 && own.length !== subjects.length;
            return (
              <span key={s.id} className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <button type="button" style={{ background: 'none', border: 0, padding: 0, color: 'inherit', cursor: 'pointer', font: 'inherit' }}
                  title={differs
                    ? `${subjectNames(own).join(', ')} — click to view students`
                    : `View students in ${klass.name} · Section ${s.name}`}
                  onClick={() => onOpenStudents(s.id)}>
                  Section {s.name}{differs && ` · ${own.length} subjects`}
                </button>
                <button type="button" aria-label={`Rename section ${s.name}`} title="Rename"
                  style={{ background: 'none', border: 0, padding: 0, color: 'inherit', opacity: 0.6, cursor: 'pointer', fontSize: 11 }}
                  onClick={() => {
                    const next = prompt(`Rename section "${s.name}" to:`, s.name);
                    if (next && next.trim() && next.trim() !== s.name) onRenameSection(s.id, next.trim());
                  }}>
                  ✎
                </button>
                <button type="button" aria-label={`Delete section ${s.name}`} title="Delete"
                  style={{ background: 'none', border: 0, padding: 0, color: 'inherit', opacity: 0.6, cursor: 'pointer', fontSize: 12 }}
                  onClick={() => { if (confirm(`Delete section "${s.name}"? This cannot be undone.`)) onDeleteSection(s.id); }}>
                  ✕
                </button>
              </span>
            );
          })
        ) : (
          <span className="badge" style={{ background: '#fef3c7', color: '#92400e' }}>Needs a section before students can be admitted</span>
        )}
      </div>

      {panel === 'subject' && (
        <div className="inline-form" style={{ marginTop: 4 }}>
          <div style={{ flex: 1 }}>
            <label>Subject name{parsed.length > 1 ? 's' : ''}</label>
            <input autoFocus value={input} onChange={(e) => setInput(e.target.value)} placeholder="Maths, Physics, Urdu" />
          </div>
          <button disabled={!parsed.length} onClick={() => { onAddSubjects(parsed); setInput(''); setPanel(null); }}>
            {parsed.length > 1 ? `Add ${parsed.length} subjects` : 'Add subject'}
          </button>
        </div>
      )}

      {panel === 'section' && (
        <div className="stack" style={{ gap: 10, marginTop: 4, padding: 12, border: '1px solid #c7d2fe', borderRadius: 8 }}>
          <div className="inline-form">
            <div style={{ flex: 1 }}>
              <label>Section name{parsed.length > 1 ? 's' : ''}</label>
              <input autoFocus value={input} onChange={(e) => setInput(e.target.value)} placeholder="A, B, C" />
            </div>
          </div>

          {/* Subjects usually match across sections; electives are where they diverge. */}
          {subjects.length > 0 && (
            <div className="stack" style={{ gap: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>Which subjects will this section study?</span>
              {sections.length > 0 && (
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: 0, color: 'var(--ink)', fontSize: 14 }}>
                  <input type="radio" style={{ width: 'auto' }} checked={mode === 'same'} onChange={() => setMode('same')} />
                  Same as an existing section
                  <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} disabled={mode !== 'same'} style={{ width: 'auto' }}>
                    {sections.map((s) => <option key={s.id} value={s.id}>Section {s.name}</option>)}
                  </select>
                </label>
              )}
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: 0, color: 'var(--ink)', fontSize: 14 }}>
                <input type="radio" style={{ width: 'auto' }} checked={mode === 'choose' || sections.length === 0} onChange={() => setMode('choose')} />
                Choose different subjects
              </label>
              {(mode === 'choose' || sections.length === 0) && (
                <div className="stack" style={{ gap: 8 }}>
                  <div className="chips">
                    {subjects.map((s) => {
                      const on = picked.includes(s.id);
                      return (
                        <button key={s.id} type="button" className="badge"
                          style={{ border: on ? '1px solid var(--brand)' : '1px solid var(--border)', cursor: 'pointer', background: on ? '#eef2ff' : '#fff', color: on ? '#3730a3' : 'var(--muted)' }}
                          onClick={() => setPicked((p) => (on ? p.filter((x) => x !== s.id) : [...p, s.id]))}>
                          {on ? '✓ ' : ''}{s.name}
                        </button>
                      );
                    })}
                  </div>

                  <div className="inline-form">
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <label>Subject not listed? Add it</label>
                      <input
                        value={newSubject}
                        onChange={(e) => setNewSubject(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addSubjectInline(); } }}
                        placeholder="e.g. Biology"
                      />
                    </div>
                    <button className="ghost" type="button" disabled={!newSubject.trim() || addingSubject} onClick={() => void addSubjectInline()}>
                      {addingSubject ? 'Adding…' : 'Add subject'}
                    </button>
                  </div>
                  <span className="muted" style={{ fontSize: 12 }}>
                    Added to <strong>{klass.name}</strong>&apos;s subject list and ticked for this section.
                  </span>
                </div>
              )}
              {mode === 'same' && sections.length > 0 && (
                <span className="muted" style={{ fontSize: 12 }}>
                  Copies: {subjectNames(sections.find((x) => x.id === copyFrom)?.subjectIds ?? subjects.map((s) => s.id)).join(', ') || 'all subjects'}
                </span>
              )}
            </div>
          )}

          <div>
            <button disabled={!parsed.length}
              onClick={() => {
                const choice: SubjectChoice =
                  subjects.length === 0 ? {}
                    : mode === 'same' && sections.length > 0 ? { copySubjectsFromSectionId: copyFrom }
                      : { subjectIds: picked };
                onAddSections(parsed, choice);
                setInput(''); setPanel(null);
              }}>
              {parsed.length > 1 ? `Add ${parsed.length} sections` : 'Add section'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
