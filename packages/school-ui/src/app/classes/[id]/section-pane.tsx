'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ManagedTeacher, Section, Subject, TeacherAssignment } from '@sw/api-client';
import { ConfirmDialog } from '../confirm-dialog';

/**
 * One section, in full: its seats, **the subjects it studies**, and who teaches each of them.
 *
 * The subject list is the capability this screen exists for. `PUT /sections/:id/subjects`
 * shipped months ago and nothing ever called it, so a section's subjects could be chosen once
 * at creation and never corrected — the only remedy was deleting the section, which the server
 * refuses once a student is enrolled in it.
 */
export function SectionPane({
  section, klassName, classSubjects, teachers, assignments, hasCurrentYear, canEdit, busyKey,
  onUpdate, onDelete, onSetSubjects, onAssign, onCreateSubject,
}: {
  section: Section;
  klassName: string;
  classSubjects: Subject[];
  teachers: ManagedTeacher[];
  assignments: TeacherAssignment[];
  hasCurrentYear: boolean;
  canEdit: boolean;
  busyKey: string;
  onUpdate: (body: { name?: string; capacity?: number }) => Promise<string | null> | void;
  onDelete: () => Promise<string | null> | void;
  onSetSubjects: (subjectIds: string[]) => Promise<string | null> | void;
  onAssign: (subjectId: string | null, staffId: string) => Promise<string | null> | void;
  onCreateSubject: (name: string) => Promise<Subject | null>;
}) {
  const inherits = !section.subjectIds?.length;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(section.name);
  const [capacity, setCapacity] = useState(String(section.capacity));
  const [mode, setMode] = useState<'inherit' | 'own'>(inherits ? 'inherit' : 'own');
  const [picked, setPicked] = useState<string[]>(section.subjectIds?.length ? section.subjectIds : classSubjects.map((s) => s.id));
  const [newSubject, setNewSubject] = useState('');
  const [addingSubject, setAddingSubject] = useState(false);
  const [savingSubjects, setSavingSubjects] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);

  // Switching sections reuses this component, so the form must follow the section it shows —
  // otherwise section B opens holding section A's answers.
  useEffect(() => {
    setEditing(false);
    setName(section.name);
    setCapacity(String(section.capacity));
    setMode(section.subjectIds?.length ? 'own' : 'inherit');
    setPicked(section.subjectIds?.length ? section.subjectIds : classSubjects.map((s) => s.id));
    setNewSubject('');
  }, [section.id, section.name, section.capacity, section.subjectIds, classSubjects]);

  /** What the section studies right now — the class catalogue when it has no list of its own. */
  const studied = useMemo(
    () => (inherits ? classSubjects : classSubjects.filter((s) => section.subjectIds!.includes(s.id))),
    [inherits, classSubjects, section.subjectIds],
  );

  const assignmentFor = (subjectId: string | null) =>
    assignments.find((a) => a.sectionId === section.id && (a.subjectId ?? null) === subjectId) ?? null;
  const homeroom = assignmentFor(null);
  const uncovered = studied.filter((s) => !assignmentFor(s.id)).length;

  const enrolled = section.enrolled ?? 0;
  const seatsTooSmall = Number(capacity) < enrolled;
  // Sending the class's full list would write an explicit copy of it — a section that then
  // silently stops tracking the class as subjects are added. Empty means "follow the class".
  const nextSubjectIds = mode === 'inherit' ? [] : picked;
  const subjectsDirty = nextSubjectIds.slice().sort().join() !== (section.subjectIds ?? []).slice().sort().join();

  async function addSubjectInline() {
    const value = newSubject.trim();
    if (!value) return;
    const existing = classSubjects.find((s) => s.name.toLowerCase() === value.toLowerCase());
    if (existing) {
      setPicked((p) => (p.includes(existing.id) ? p : [...p, existing.id]));
      setNewSubject('');
      return;
    }
    setAddingSubject(true);
    const created = await onCreateSubject(value);
    if (created) { setPicked((p) => [...p, created.id]); setNewSubject(''); }
    setAddingSubject(false);
  }

  async function saveSubjects() {
    setSavingSubjects(true);
    try { await onSetSubjects(nextSubjectIds); } finally { setSavingSubjects(false); }
  }

  return (
    <div className="card stack" style={{ borderColor: 'var(--brand)' }}>
      <div className="row">
        <div className="stack" style={{ gap: 2 }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>{klassName} · Section {section.name}</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {enrolled} of {section.capacity} seats · {studied.length} subject{studied.length === 1 ? '' : 's'}
            {uncovered > 0 && <> · <span style={{ color: '#b45309', fontWeight: 600 }}>{uncovered} without a teacher</span></>}
          </p>
        </div>
        {canEdit && !editing && (
          <div className="chips">
            <button className="ghost small" type="button" onClick={() => setEditing(true)}>Edit name &amp; seats</button>
            <button className="ghost small" type="button" style={{ color: '#b91c1c' }} onClick={() => setPendingDelete(true)}>
              Delete section
            </button>
          </div>
        )}
      </div>

      {editing && (
        <div className="inline-form">
          <div style={{ minWidth: 150 }}>
            <label>Section name</label>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div style={{ maxWidth: 120 }}>
            <label>Seats</label>
            <input type="number" min={1} max={200} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
          </div>
          <button
            type="button"
            disabled={!name.trim() || !Number(capacity) || seatsTooSmall}
            onClick={() => { onUpdate({ name: name.trim(), capacity: Number(capacity) }); setEditing(false); }}
          >
            Save
          </button>
          <button className="ghost" type="button" onClick={() => setEditing(false)}>Cancel</button>
          {seatsTooSmall && (
            <span className="field-error">{enrolled} students are already enrolled — seats cannot be below {enrolled}.</span>
          )}
        </div>
      )}

      {/* ── Which subjects this section studies ───────────────────────────────── */}
      <div className="stack" style={{ gap: 8, paddingTop: 4, borderTop: '1px solid var(--border)' }}>
        <div className="stack" style={{ gap: 2 }}>
          <strong style={{ fontSize: 14 }}>Subjects this section studies</strong>
          <span className="muted" style={{ fontSize: 12 }}>
            Picked from {klassName}&apos;s catalogue. Most sections study everything the class offers;
            electives are where they differ.
          </span>
        </div>

        {classSubjects.length === 0 ? (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {klassName} has no subjects yet — add them in the Subjects panel above and they will
            appear here.
          </p>
        ) : !canEdit ? (
          <div className="chips">
            {studied.map((s) => <span key={s.id} className="badge">{s.name}</span>)}
          </div>
        ) : (
          <>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: 0, color: 'var(--ink)', fontSize: 14 }}>
              <input type="radio" style={{ width: 'auto' }} checked={mode === 'inherit'} onChange={() => setMode('inherit')} />
              Same as the class — all {classSubjects.length} subject{classSubjects.length === 1 ? '' : 's'}
              <span className="muted" style={{ fontSize: 12 }}>(follows the class as subjects are added)</span>
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: 0, color: 'var(--ink)', fontSize: 14 }}>
              <input type="radio" style={{ width: 'auto' }} checked={mode === 'own'} onChange={() => setMode('own')} />
              Choose for this section
            </label>

            {mode === 'own' && (
              <div className="stack" style={{ gap: 8 }}>
                <div className="chips">
                  {classSubjects.map((s) => {
                    const on = picked.includes(s.id);
                    const taught = assignmentFor(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        className="badge"
                        aria-pressed={on}
                        title={taught ? `Taught by ${taught.teacherName}` : undefined}
                        style={{
                          cursor: 'pointer',
                          border: on ? '1px solid var(--brand)' : '1px solid var(--border)',
                          background: on ? '#eef2ff' : '#fff',
                          color: on ? '#3730a3' : 'var(--muted)',
                        }}
                        onClick={() => setPicked((p) => (on ? p.filter((x) => x !== s.id) : [...p, s.id]))}
                      >
                        {on ? '✓ ' : ''}{s.name}
                      </button>
                    );
                  })}
                </div>

                {/* Dropping a subject that has a teacher leaves that assignment behind with
                    nothing to teach. Say so before saving rather than after. */}
                {classSubjects.some((s) => !picked.includes(s.id) && assignmentFor(s.id)) && (
                  <div className="toast warn" style={{ margin: 0 }}>
                    {classSubjects
                      .filter((s) => !picked.includes(s.id) && assignmentFor(s.id))
                      .map((s) => `${s.name} (${assignmentFor(s.id)!.teacherName})`)
                      .join(', ')}{' '}
                    — removing a subject leaves its teacher assigned to nothing in this section.
                  </div>
                )}

                <div className="inline-form">
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <label>Subject not in the class list? Add it</label>
                    <input
                      value={newSubject}
                      onChange={(e) => setNewSubject(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addSubjectInline(); } }}
                      placeholder="e.g. Biology"
                    />
                    <span className="field-hint">Added to {klassName}&apos;s catalogue and ticked here.</span>
                  </div>
                  <button className="ghost" type="button" disabled={!newSubject.trim() || addingSubject} onClick={() => void addSubjectInline()}>
                    {addingSubject ? 'Adding…' : 'Add subject'}
                  </button>
                </div>
              </div>
            )}

            <div className="chips">
              <button type="button" disabled={!subjectsDirty || savingSubjects || (mode === 'own' && picked.length === 0)} onClick={() => void saveSubjects()}>
                {savingSubjects ? 'Saving…' : 'Save subjects'}
              </button>
              {subjectsDirty && (
                <button
                  className="ghost small"
                  type="button"
                  onClick={() => {
                    setMode(section.subjectIds?.length ? 'own' : 'inherit');
                    setPicked(section.subjectIds?.length ? section.subjectIds : classSubjects.map((s) => s.id));
                  }}
                >
                  Discard changes
                </button>
              )}
              {mode === 'own' && picked.length === 0 && (
                <span className="muted" style={{ fontSize: 12 }}>
                  Pick at least one subject, or choose &ldquo;Same as the class&rdquo;.
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Who teaches it ────────────────────────────────────────────────────── */}
      <div className="stack" style={{ gap: 8, paddingTop: 4, borderTop: '1px solid var(--border)' }}>
        <strong style={{ fontSize: 14 }}>Teachers</strong>

        <div className="chips">
          <span className="muted" style={{ fontSize: 13, minWidth: 90 }}>Class teacher</span>
          {canEdit ? (
            <select
              style={{ maxWidth: 280, width: 'auto' }}
              disabled={!hasCurrentYear || busyKey === `${section.id}:homeroom`}
              value={homeroom?.staffId ?? ''}
              onChange={(e) => onAssign(null, e.target.value)}
            >
              <option value="">— none —</option>
              {teachers.map((t) => <option key={t.id} value={t.id}>{t.fullName ?? t.user.email}</option>)}
            </select>
          ) : (
            <span className={homeroom ? 'badge ok' : 'badge warn'}>{homeroom?.teacherName ?? 'None'}</span>
          )}
        </div>

        {studied.length === 0 ? (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>Add subjects above to assign subject teachers.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>Subject</th><th>Teacher</th><th style={{ textAlign: 'right' }}>Status</th></tr></thead>
              <tbody>
                {studied.map((s) => {
                  const a = assignmentFor(s.id);
                  return (
                    <tr key={s.id}>
                      <td>{s.name}</td>
                      <td>
                        {canEdit ? (
                          <select
                            style={{ maxWidth: 280 }}
                            disabled={!hasCurrentYear || busyKey === `${section.id}:${s.id}`}
                            value={a?.staffId ?? ''}
                            onChange={(e) => onAssign(s.id, e.target.value)}
                          >
                            <option value="">— unassigned —</option>
                            {teachers.map((t) => <option key={t.id} value={t.id}>{t.fullName ?? t.user.email}</option>)}
                          </select>
                        ) : (
                          <span>{a?.teacherName ?? '—'}</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {a ? <span className="badge ok">{a.teacherName}</span> : <span className="badge warn">Unassigned</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete Section ${section.name}?`}
          body={
            enrolled > 0
              ? `${enrolled} student${enrolled === 1 ? ' is' : 's are'} enrolled — deleting will be refused until they are moved.`
              : 'Deleting is blocked while students, teacher assignments or timetable slots belong to it.'
          }
          confirmLabel="Delete section"
          onConfirm={onDelete}
          onClose={() => setPendingDelete(false)}
        />
      )}
    </div>
  );
}
