'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { type Campus, type Klass, type Section, type Subject, type SubjectCatalogueEntry } from '@/lib/api';
import { nearestSubject } from '@/lib/subject-match';
import { ConfirmDialog } from './confirm-dialog';

/** Classes and sections are one job, not two — a class without sections can't take a
 *  student, so sections are added inline on the class they belong to rather than from a
 *  separate card with its own class dropdown. */
export function ClassManager({ classes, sections, subjects, campuses, catalogue, showTools = false, onCreateClass, onCreateSections, onCreateSubjects, onCreateSubjectInline, onUpdateClass, onDeleteClass, onReorderClass, onUpdateSection, onDeleteSection, onDeleteSubject }: {
  classes: Klass[]; sections: Section[]; subjects: Subject[]; campuses: Campus[]; catalogue: SubjectCatalogueEntry[];
  showTools?: boolean;
  onCreateClass: (b: object) => Promise<string | null>;
  onCreateSections: (classId: string, names: string[], subjectChoice: SubjectChoice, capacity?: number) => void;
  onCreateSubjects: (classId: string, names: string[]) => void;
  onCreateSubjectInline: (classId: string, name: string) => Promise<Subject | null>;
  onUpdateClass: (id: string, body: { name?: string; minAgeYears?: number; maxAgeYears?: number }) => void;
  onDeleteClass: (id: string) => Promise<string | null> | void;
  onReorderClass?: (updates: { id: string; order: number }[]) => void;
  onUpdateSection: (id: string, body: { name?: string; capacity?: number }) => void;
  onDeleteSection: (id: string) => Promise<string | null> | void;
  onDeleteSubject: (id: string) => Promise<string | null> | void;
}) {
  const router = useRouter();
  const [campusId, setCampusId] = useState('');
  const [name, setName] = useState('');
  const [search, setSearch] = useState('');
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

  const query = search.trim().toLowerCase();
  const matches = (k: Klass) => {
    if (!query) return true;
    const ownSubjects = subjects.filter((s) => s.classId === k.id).map((s) => s.name).join(' ');
    const ownSections = sections.filter((s) => s.classId === k.id).map((s) => s.name).join(' ');
    return `${k.name} ${ownSubjects} ${ownSections}`.toLowerCase().includes(query);
  };

  const groups = campuses
    .map((c) => ({
      id: c.id,
      campus: c.name,
      items: classes.filter((k) => k.campusId === c.id && matches(k)).sort((a, b) => a.order - b.order),
    }))
    .filter((g) => g.items.length > 0);

  const totalMatched = groups.reduce((n, g) => n + g.items.length, 0);
  const enrolmentUncounted = sections.length > 0 && sections.every((s) => s.enrolled == null);
  const catalogueListId = 'subject-catalogue';

  return (
    <>
      {enrolmentUncounted && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Seats show capacity only — set a current school year to count enrolment.
        </p>
      )}
      {showTools && classes.length > 0 && (
        <div className="inline-form">
          <div style={{ minWidth: 240 }}>
            <label>Search classes, sections or subjects</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. 9th, Biology, Section B" />
          </div>
          {query && <button className="ghost" onClick={() => setSearch('')}>Clear</button>}
          {query && <span className="muted" style={{ fontSize: 13 }}>{totalMatched} match{totalMatched === 1 ? '' : 'es'}</span>}
        </div>
      )}

      {classes.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          No classes yet. Add your first class below — for example “Nursery”, “Grade 1” or “9th”.
        </p>
      ) : totalMatched === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>No class matches “{search}”.</p>
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          {groups.map((g) => (
            <div key={g.id} className="stack" style={{ gap: 8 }}>
              {campuses.length > 1 && (
                <div className="muted" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  {g.campus}
                </div>
              )}
              {g.items.map((k, index) => (
                <ClassRow key={k.id} klass={k} catalogue={catalogue} catalogueListId={catalogueListId}
                  sections={sections.filter((s) => s.classId === k.id).sort((a, b) => a.name.localeCompare(b.name))}
                  subjects={subjects.filter((s) => s.classId === k.id).sort((a, b) => a.name.localeCompare(b.name))}
                  openSubjectsOnMount={justCreated === k.id}
                  onAddSections={(names, choice, capacity) => onCreateSections(k.id, names, choice, capacity)}
                  onAddSubjects={(names) => onCreateSubjects(k.id, names)}
                  onCreateSubjectInline={(name) => onCreateSubjectInline(k.id, name)}
                  onUpdate={(body) => onUpdateClass(k.id, body)}
                  onDelete={() => onDeleteClass(k.id)}
                  onMoveUp={showTools && onReorderClass && index > 0
                    ? () => onReorderClass(resequence(g.items, index, index - 1))
                    : undefined}
                  onMoveDown={showTools && onReorderClass && index < g.items.length - 1
                    ? () => onReorderClass(resequence(g.items, index, index + 1))
                    : undefined}
                  onUpdateSection={onUpdateSection}
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
        {(!name.trim() || !targetCampus) && (
          <span className="muted" style={{ fontSize: 12 }}>
            {!targetCampus ? 'Choose a campus first.' : 'Enter a class name.'}
          </span>
        )}
      </div>

      <datalist id={catalogueListId}>
        {catalogue.map((c) => <option key={c.name} value={c.name} />)}
      </datalist>
    </>
  );
}

/** How a new section gets its subject list: copy a sibling's, pick explicitly, or (neither)
 *  inherit everything the class offers. */
export type SubjectChoice = { copySubjectsFromSectionId?: string; subjectIds?: string[] };

function resequence(items: Klass[], from: number, to: number): { id: string; order: number }[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next
    .map((k, i) => ({ id: k.id, order: i + 1 }))
    .filter((u, i) => next[i].order !== u.order);
}

/** One class: its sections, its subjects, when it was created, and the controls to add more.
 *  Sections and subjects both accept a comma-separated list, because entering "A, B, C" or
 *  "Maths, Physics, Urdu" in one go is how a school actually thinks about them. */
function ClassRow({ klass, sections, subjects, catalogue, catalogueListId, openSubjectsOnMount, onAddSections, onAddSubjects, onCreateSubjectInline, onUpdate, onDelete, onMoveUp, onMoveDown, onUpdateSection, onDeleteSection, onDeleteSubject, onOpenStudents }: {
  klass: Klass; sections: Section[]; subjects: Subject[]; catalogue: SubjectCatalogueEntry[]; catalogueListId: string; openSubjectsOnMount?: boolean;
  onAddSections: (names: string[], choice: SubjectChoice, capacity?: number) => void;
  onAddSubjects: (names: string[]) => void;
  onCreateSubjectInline: (name: string) => Promise<Subject | null>;
  onUpdate: (body: { name?: string; minAgeYears?: number; maxAgeYears?: number }) => void;
  onDelete: () => Promise<string | null> | void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onUpdateSection: (id: string, body: { name?: string; capacity?: number }) => void;
  onDeleteSection: (id: string) => Promise<string | null> | void;
  onDeleteSubject: (id: string) => Promise<string | null> | void;
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
  const [renaming, setRenaming] = useState<{ name: string; minAge: string; maxAge: string } | null>(null);
  const [editingSection, setEditingSection] = useState<{ id: string; name: string; capacity: string } | null>(null);
  const [newCapacity, setNewCapacity] = useState('40');
  const [nameWarnings, setNameWarnings] = useState<{ typed: string; suggestion: string; classCount: number }[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    title: string; body: string; confirmLabel: string; run: () => Promise<string | null> | void;
  } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
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

  const catalogueNames = catalogue.map((c) => c.name);

  function commitSubjects(names: string[]) {
    onAddSubjects(names);
    setInput('');
    setPanel(null);
    setNameWarnings(null);
  }

  function submitSubjects() {
    const found = parsed.flatMap((typed) => {
      const suggestion = nearestSubject(typed, catalogueNames);
      if (!suggestion) return [];
      const classCount = catalogue.find((c) => c.name === suggestion)?.classCount ?? 0;
      return [{ typed, suggestion, classCount }];
    });
    if (found.length) {
      setNameWarnings(found);
      return;
    }
    commitSubjects(parsed);
  }

  function useSuggestion(typed: string, suggestion: string) {
    setInput(parsed.map((n) => (n === typed ? suggestion : n)).join(', '));
    setNameWarnings(null);
  }

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

  const ageMin = renaming ? Number(renaming.minAge) : NaN;
  const ageMax = renaming ? Number(renaming.maxAge) : NaN;
  const ageInvalid = Boolean(renaming?.minAge && renaming?.maxAge && ageMin >= ageMax);

  function saveClass() {
    if (!renaming || !renaming.name.trim() || ageInvalid) return;
    onUpdate({
      name: renaming.name.trim(),
      minAgeYears: renaming.minAge ? Number(renaming.minAge) : undefined,
      maxAgeYears: renaming.maxAge ? Number(renaming.maxAge) : undefined,
    });
    setRenaming(null);
  }

  const needsSection = sections.length === 0;
  const needsSubjects = subjects.length === 0;
  const ready = !needsSection && !needsSubjects;
  const strengthKnown = sections.some((s) => s.enrolled != null);
  const strength = sections.reduce((n, s) => n + (s.enrolled ?? 0), 0);
  const ageRange = klass.minAgeYears != null || klass.maxAgeYears != null
    ? `Age ${klass.minAgeYears ?? '—'}–${klass.maxAgeYears ?? '—'}`
    : null;

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 12px' }} className="stack">
      <div className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {renaming === null ? (
          <>
            <strong style={{ minWidth: 70 }} title={created ? `Created ${created}` : undefined}>{klass.name}</strong>
            {ready
              ? <span className="badge ok">Ready</span>
              : <span className="badge warn">
                  {needsSection && needsSubjects ? 'Needs a section and subjects' : needsSection ? 'Needs a section' : 'Needs subjects'}
                </span>}
            {strengthKnown && (
              <span className="muted" style={{ fontSize: 12 }}>{strength} student{strength === 1 ? '' : 's'}</span>
            )}
            {ageRange && <span className="muted" style={{ fontSize: 12 }}>{ageRange}</span>}
          </>
        ) : (
          <div className="inline-form" style={{ flex: 1 }}>
            <div style={{ flex: 1, minWidth: 160 }}>
              <label>Class name</label>
              <input autoFocus value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && renaming.name.trim()) saveClass();
                  if (e.key === 'Escape') setRenaming(null);
                }} />
            </div>
            <div style={{ maxWidth: 110 }}>
              <label>Min age</label>
              <input type="number" min={2} max={30} value={renaming.minAge}
                onChange={(e) => setRenaming({ ...renaming, minAge: e.target.value })} placeholder="any" />
            </div>
            <div style={{ maxWidth: 110 }}>
              <label>Max age</label>
              <input type="number" min={2} max={30} value={renaming.maxAge}
                onChange={(e) => setRenaming({ ...renaming, maxAge: e.target.value })} placeholder="any" />
            </div>
            <button type="button" disabled={!renaming.name.trim() || ageInvalid} onClick={saveClass}>Save</button>
            <button className="ghost" type="button" onClick={() => setRenaming(null)}>Cancel</button>
            <span className="muted" style={{ fontSize: 12 }}>
              {ageInvalid ? 'Min age must be below max age.' : 'Age warns during admission; the controller can override.'}
            </span>
          </div>
        )}
        {renaming === null && (
          <div className="row" style={{ gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
            {(onMoveUp || onMoveDown) && (
              <span className="row" style={{ gap: 2 }}>
                <button className="ghost small" aria-label={`Move ${klass.name} up`} title="Move up"
                  disabled={!onMoveUp} onClick={onMoveUp}>↑</button>
                <button className="ghost small" aria-label={`Move ${klass.name} down`} title="Move down"
                  disabled={!onMoveDown} onClick={onMoveDown}>↓</button>
              </span>
            )}
            <button className="small" onClick={() => open('section')}>{panel === 'section' ? 'Cancel' : '+ Section'}</button>
            <button className="ghost small" onClick={() => open('subject')}>{panel === 'subject' ? 'Cancel' : '+ Subject'}</button>
            <span style={{ position: 'relative' }}>
              <button className="ghost small" aria-haspopup="menu" aria-expanded={menuOpen}
                aria-label={`More actions for ${klass.name}`} onClick={() => setMenuOpen((v) => !v)}>⋯</button>
              {menuOpen && (
                <span role="menu" onMouseLeave={() => setMenuOpen(false)}
                  style={{
                    position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 20,
                    background: '#fff', border: '1px solid var(--border)', borderRadius: 8,
                    boxShadow: '0 6px 18px rgba(15,23,42,0.12)', padding: 4, display: 'grid', minWidth: 168,
                  }}>
                  <button className="ghost small" role="menuitem" style={{ textAlign: 'left' }}
                    onClick={() => { setMenuOpen(false); setRenaming({ name: klass.name, minAge: klass.minAgeYears?.toString() ?? '', maxAge: klass.maxAgeYears?.toString() ?? '' }); }}>
                    Edit name &amp; age
                  </button>
                  <button className="ghost small" role="menuitem" style={{ textAlign: 'left' }}
                    onClick={() => { setMenuOpen(false); router.push(`/classes/${klass.id}`); }}>Teachers</button>
                  <button className="ghost small" role="menuitem" style={{ textAlign: 'left' }}
                    onClick={() => { setMenuOpen(false); onOpenStudents(); }}>View students</button>
                  {/* The server refuses while sections/fees/exams depend on it and says which. */}
                  <button className="ghost small" role="menuitem" style={{ textAlign: 'left', color: '#b91c1c' }}
                    onClick={() => {
                      setMenuOpen(false);
                      setPendingDelete({
                        title: `Delete class “${klass.name}”?`,
                        body: sections.length || subjects.length
                          ? `It has ${sections.length} section${sections.length === 1 ? '' : 's'} and ${subjects.length} subject${subjects.length === 1 ? '' : 's'}. Deleting is blocked while students, fees or exams depend on it.`
                          : 'This class has no sections or subjects yet.',
                        confirmLabel: 'Delete class',
                        run: () => onDelete(),
                      });
                    }}>
                    Delete class
                  </button>
                </span>
              )}
            </span>
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
                  style={{ background: 'none', border: 0, padding: '4px 6px', color: 'inherit', opacity: 0.7, cursor: 'pointer', fontSize: 12, minWidth: 24, minHeight: 24 }}
                  onClick={() => setPendingDelete({
                    title: `Remove “${s.name}” from ${klass.name}?`,
                    body: 'Removal is blocked while exam results, teacher assignments or timetable slots reference this subject.',
                    confirmLabel: 'Remove subject',
                    run: () => onDeleteSubject(s.id),
                  })}>
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
            const inheritsAll = own.length === 0 || own.length === subjects.length;
            const subjectLabel = subjects.length === 0
              ? null
              : inheritsAll ? `all ${subjects.length} subjects` : `${own.length} of ${subjects.length} subjects`;
            const taken = s.enrolled;
            const counted = taken != null;
            const full = counted && taken >= s.capacity;
            return (
              <span key={s.id} className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <button type="button" style={{ background: 'none', border: 0, padding: 0, color: 'inherit', cursor: 'pointer', font: 'inherit' }}
                  title={!inheritsAll
                    ? `${subjectNames(own).join(', ')} — click to view students`
                    : `View students in ${klass.name} · Section ${s.name}`}
                  onClick={() => onOpenStudents(s.id)}>
                  Section {s.name}{subjectLabel ? ` · ${subjectLabel}` : ''}
                </button>
                <span title={counted
                    ? `${taken} of ${s.capacity} seats filled`
                    : `${s.capacity} seats — enrolment isn't counted without a current school year`}
                  style={{
                    fontSize: 11, fontWeight: 600, padding: '1px 6px', borderRadius: 999,
                    background: full ? '#fee2e2' : '#e0e7ff', color: full ? '#991b1b' : '#3730a3',
                  }}>
                  {counted ? taken : '—'}/{s.capacity}{full ? ' full' : ''}
                </span>
                <button type="button" aria-label={`Edit section ${s.name}`} title="Edit name and seats"
                  style={{ background: 'none', border: 0, padding: '4px 6px', color: 'inherit', opacity: 0.7, cursor: 'pointer', fontSize: 12, minWidth: 24, minHeight: 24 }}
                  onClick={() => setEditingSection(editingSection?.id === s.id ? null : { id: s.id, name: s.name, capacity: String(s.capacity) })}>
                  ✎
                </button>
                <button type="button" aria-label={`Delete section ${s.name}`} title="Delete"
                  style={{ background: 'none', border: 0, padding: '4px 6px', color: 'inherit', opacity: 0.7, cursor: 'pointer', fontSize: 12, minWidth: 24, minHeight: 24 }}
                  onClick={() => setPendingDelete({
                    title: `Delete Section ${s.name}?`,
                    body: counted && taken > 0
                      ? `${taken} student${taken === 1 ? ' is' : 's are'} enrolled — deleting will be refused until they are moved.`
                      : 'Deleting is blocked while students, teacher assignments or timetable slots belong to it.',
                    confirmLabel: 'Delete section',
                    run: () => onDeleteSection(s.id),
                  })}>
                  ✕
                </button>
              </span>
            );
          })
        ) : (
          <span className="badge" style={{ background: '#fef3c7', color: '#92400e' }}>Needs a section before students can be admitted</span>
        )}
      </div>

      {editingSection && (
        <div className="stack" style={{ gap: 6, marginTop: 4 }}>
          <strong style={{ fontSize: 13 }}>
            Editing Section {sections.find((x) => x.id === editingSection.id)?.name ?? editingSection.name}
          </strong>
          <div className="inline-form">
          <div style={{ minWidth: 140 }}>
            <label>Section name</label>
            <input autoFocus value={editingSection.name}
              onChange={(e) => setEditingSection({ ...editingSection, name: e.target.value })} />
          </div>
          <div style={{ maxWidth: 120 }}>
            <label>Seats</label>
            <input type="number" min={1} max={200} value={editingSection.capacity}
              onChange={(e) => setEditingSection({ ...editingSection, capacity: e.target.value })} />
          </div>
          {(() => {
            const target = sections.find((x) => x.id === editingSection.id);
            const taken = target?.enrolled ?? 0;
            const next = Number(editingSection.capacity);
            const tooSmall = Number.isFinite(next) && next < taken;
            return (
              <>
                <button type="button" disabled={!editingSection.name.trim() || !next || tooSmall}
                  onClick={() => {
                    onUpdateSection(editingSection.id, { name: editingSection.name.trim(), capacity: next });
                    setEditingSection(null);
                  }}>
                  Save
                </button>
                <button type="button" className="ghost" onClick={() => setEditingSection(null)}>Cancel</button>
                {tooSmall && (
                  <span className="muted" style={{ fontSize: 12, color: '#b91c1c' }}>
                    {taken} students are already enrolled — seats cannot be below {taken}.
                  </span>
                )}
              </>
            );
          })()}
          </div>
        </div>
      )}

      {panel === 'subject' && (
        <div className="stack" style={{ gap: 8, marginTop: 4 }}>
          <div className="inline-form">
            <div style={{ flex: 1 }}>
              <label>Subject name{parsed.length > 1 ? 's' : ''}</label>
              <input autoFocus list={catalogueListId} value={input}
                onChange={(e) => { setInput(e.target.value); setNameWarnings(null); }}
                placeholder="Maths, Physics, Urdu" />
              <span className="muted" style={{ fontSize: 12 }}>Separate with commas to add several at once.</span>
            </div>
            <button disabled={!parsed.length} onClick={submitSubjects}>
              {parsed.length > 1 ? `Add ${parsed.length} subjects` : 'Add subject'}
            </button>
          </div>
          {nameWarnings && nameWarnings.length > 0 && (
            <div className="stack" style={{ gap: 8, padding: 10, borderRadius: 8, background: '#fffbeb', border: '1px solid #fcd34d' }}>
              {nameWarnings.map((w) => (
                <div key={w.typed} className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-start' }}>
                  <span style={{ fontSize: 13 }}>
                    &ldquo;{w.typed}&rdquo; looks like &ldquo;{w.suggestion}&rdquo;, already used in {w.classCount} class{w.classCount === 1 ? '' : 'es'}.
                  </span>
                  <button className="ghost small" type="button" onClick={() => useSuggestion(w.typed, w.suggestion)}>
                    Use &ldquo;{w.suggestion}&rdquo;
                  </button>
                </div>
              ))}
              <div>
                <button className="small" type="button" onClick={() => commitSubjects(parsed)}>Add anyway</button>
              </div>
            </div>
          )}
        </div>
      )}

      {panel === 'section' && (
        <div className="stack" style={{ gap: 10, marginTop: 4, padding: 12, border: '1px solid #c7d2fe', borderRadius: 8 }}>
          <div className="inline-form">
            <div style={{ flex: 1 }}>
              <label>Section name{parsed.length > 1 ? 's' : ''}</label>
              <input autoFocus value={input} onChange={(e) => setInput(e.target.value)} placeholder="A, B, C" />
              <span className="muted" style={{ fontSize: 12 }}>Separate with commas to add several at once.</span>
            </div>
            <div style={{ maxWidth: 120 }}>
              <label>Seats each</label>
              <input type="number" min={1} max={200} value={newCapacity} onChange={(e) => setNewCapacity(e.target.value)} />
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
                Pick this section&apos;s subjects
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
                        list={catalogueListId}
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
                onAddSections(parsed, choice, Number(newCapacity) || undefined);
                setInput(''); setPanel(null);
              }}>
              {parsed.length > 1 ? `Add ${parsed.length} sections` : 'Add section'}
            </button>
          </div>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={pendingDelete.title}
          body={pendingDelete.body}
          confirmLabel={pendingDelete.confirmLabel}
          onConfirm={pendingDelete.run}
          onClose={() => setPendingDelete(null)} />
      )}
    </div>
  );
}
