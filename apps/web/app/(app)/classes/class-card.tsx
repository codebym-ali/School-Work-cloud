'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Klass, Section, Subject, TeacherAssignment } from '@/lib/api';
import { ConfirmDialog } from './confirm-dialog';

/**
 * One class, as a **report**: what it holds, and who teaches it.
 *
 * This card used to be a list and six inline forms at once — eleven pieces of local state, up
 * to three expanding panels, and per-section Edit/Delete buttons that at six sections wrapped
 * into a band of twelve controls. Every mutation except creating and reordering a class now
 * lives on the workbench, which is what makes this readable.
 *
 * The teaching tags are the point: "Biology · A. Khan" answers the question the screen could
 * never answer before without opening every teacher in the staff directory.
 */
export function ClassCard({
  klass, sections, subjects, assignments, canEdit, onRename, onDelete, onMoveUp, onMoveDown,
}: {
  klass: Klass;
  sections: Section[];
  subjects: Subject[];
  assignments: TeacherAssignment[];
  canEdit: boolean;
  onRename: (body: { name?: string; minAgeYears?: number; maxAgeYears?: number }) => Promise<string | null> | void;
  onDelete: () => Promise<string | null> | void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<{ name: string; minAge: string; maxAge: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);

  const needsSection = sections.length === 0;
  const needsSubjects = subjects.length === 0;
  const ready = !needsSection && !needsSubjects;
  const counted = sections.some((s) => s.enrolled != null);
  const strength = sections.reduce((n, s) => n + (s.enrolled ?? 0), 0);
  const ageRange = klass.minAgeYears != null || klass.maxAgeYears != null
    ? `Age ${klass.minAgeYears ?? '—'}–${klass.maxAgeYears ?? '—'}`
    : null;

  /** A section with no list of its own studies everything the class offers. */
  const studiedBy = (subjectId: string) =>
    sections.filter((s) => !s.subjectIds?.length || s.subjectIds.includes(subjectId));

  /** Teachers of this subject across the class's sections, deduped. */
  const teachersOf = (subjectId: string) =>
    Array.from(new Set(assignments.filter((a) => a.subjectId === subjectId).map((a) => a.teacherName)));

  const uncovered = subjects.filter((s) => studiedBy(s.id).length > 0 && teachersOf(s.id).length === 0);
  const classTeacherGaps = sections.filter((s) => !assignments.some((a) => a.sectionId === s.id && a.subjectId === null));

  const ageMin = editing ? Number(editing.minAge) : NaN;
  const ageMax = editing ? Number(editing.maxAge) : NaN;
  const ageInvalid = Boolean(editing?.minAge && editing?.maxAge && ageMin >= ageMax);

  function save() {
    if (!editing || !editing.name.trim() || ageInvalid) return;
    onRename({
      name: editing.name.trim(),
      minAgeYears: editing.minAge ? Number(editing.minAge) : undefined,
      maxAgeYears: editing.maxAge ? Number(editing.maxAge) : undefined,
    });
    setEditing(null);
  }

  return (
    <div className="card stack" style={{ padding: '14px 16px', gap: 10 }}>
      {editing ? (
        <div className="inline-form">
          <div style={{ flex: 1, minWidth: 160 }}>
            <label>Class name</label>
            <input
              autoFocus
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && editing.name.trim()) save();
                if (e.key === 'Escape') setEditing(null);
              }}
            />
          </div>
          <div style={{ maxWidth: 110 }}>
            <label>Min age</label>
            <input type="number" min={2} max={30} placeholder="any" value={editing.minAge}
              onChange={(e) => setEditing({ ...editing, minAge: e.target.value })} />
          </div>
          <div style={{ maxWidth: 110 }}>
            <label>Max age</label>
            <input type="number" min={2} max={30} placeholder="any" value={editing.maxAge}
              onChange={(e) => setEditing({ ...editing, maxAge: e.target.value })} />
          </div>
          <button type="button" disabled={!editing.name.trim() || ageInvalid} onClick={save}>Save</button>
          <button className="ghost" type="button" onClick={() => setEditing(null)}>Cancel</button>
          <span className="muted" style={{ fontSize: 12 }}>
            {ageInvalid ? 'Min age must be below max age.' : 'Age warns during admission; the controller can override.'}
          </span>
        </div>
      ) : (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div className="chips">
            <Link href={`/classes/${klass.id}`} style={{ fontWeight: 700, fontSize: 16, textDecoration: 'none', color: 'var(--ink)' }}>
              {klass.name}
            </Link>
            {ready
              ? <span className="badge ok" title="Has a section and subjects — students can be admitted into this class">Ready to admit</span>
              : <span className="badge warn">
                  {needsSection && needsSubjects ? 'Needs a section and subjects' : needsSection ? 'Needs a section' : 'Needs subjects'}
                </span>}
            {counted && <span className="muted" style={{ fontSize: 12 }}>{strength} student{strength === 1 ? '' : 's'}</span>}
            {ageRange && <span className="muted" style={{ fontSize: 12 }}>{ageRange}</span>}
          </div>

          <div className="chips" style={{ marginLeft: 'auto' }}>
            <Link className="chip" href={`/classes/${klass.id}`}>Manage →</Link>
            {canEdit && (
              <span style={{ position: 'relative' }}>
                <button className="ghost small" type="button" aria-haspopup="menu" aria-expanded={menuOpen}
                  aria-label={`More actions for ${klass.name}`} onClick={() => setMenuOpen((v) => !v)}>⋯</button>
                {menuOpen && (
                  <span role="menu" onMouseLeave={() => setMenuOpen(false)}
                    style={{
                      position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 20,
                      background: '#fff', border: '1px solid var(--border)', borderRadius: 8,
                      boxShadow: '0 6px 18px rgba(15,23,42,0.12)', padding: 4, display: 'grid', minWidth: 190,
                    }}>
                    <button className="ghost small" role="menuitem" style={{ textAlign: 'left' }}
                      onClick={() => { setMenuOpen(false); setEditing({ name: klass.name, minAge: klass.minAgeYears?.toString() ?? '', maxAge: klass.maxAgeYears?.toString() ?? '' }); }}>
                      Edit name &amp; age
                    </button>
                    <button className="ghost small" role="menuitem" style={{ textAlign: 'left' }}
                      onClick={() => { setMenuOpen(false); router.push(`/students?campusId=${klass.campusId}&classId=${klass.id}`); }}>
                      View students
                    </button>
                    {(onMoveUp || onMoveDown) && (
                      <>
                        {/* Order is not decoration — it decides which class a student is promoted
                            INTO at year end, so the menu says so rather than showing bare arrows. */}
                        <span className="muted" style={{ fontSize: 11, padding: '6px 8px 2px' }}>
                          Order decides the next class at promotion
                        </span>
                        <button className="ghost small" role="menuitem" style={{ textAlign: 'left' }}
                          disabled={!onMoveUp} onClick={() => { setMenuOpen(false); onMoveUp?.(); }}>Move earlier</button>
                        <button className="ghost small" role="menuitem" style={{ textAlign: 'left' }}
                          disabled={!onMoveDown} onClick={() => { setMenuOpen(false); onMoveDown?.(); }}>Move later</button>
                      </>
                    )}
                    <button className="ghost small" role="menuitem" style={{ textAlign: 'left', color: '#b91c1c' }}
                      onClick={() => { setMenuOpen(false); setPendingDelete(true); }}>
                      Delete class
                    </button>
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Sections — read-only here. Seats and the class teacher are what you scan for; changing
          them is the workbench's job. */}
      <div className="chips">
        <span className="muted" style={{ fontSize: 12, minWidth: 62 }}>Sections</span>
        {sections.length === 0 ? (
          <span className="badge warn">None yet — students cannot be admitted</span>
        ) : (
          sections.map((s) => {
            const taken = s.enrolled;
            const full = taken != null && taken >= s.capacity;
            const ct = assignments.find((a) => a.sectionId === s.id && a.subjectId === null);
            return (
              <Link key={s.id} className="chip" href={`/classes/${klass.id}?section=${s.id}`}
                title={ct ? `Class teacher: ${ct.teacherName}` : 'No class teacher assigned'}>
                <strong style={{ fontWeight: 600 }}>{s.name}</strong>
                <span className={full ? 'badge bad' : 'badge'}>{taken ?? '—'} of {s.capacity}</span>
                <span className="muted" style={{ fontSize: 12 }}>{ct ? ct.teacherName : 'no class teacher'}</span>
              </Link>
            );
          })
        )}
      </div>

      {/* Teaching — the tags. Subject · teacher, green when covered, amber when not. */}
      <div className="chips">
        <span className="muted" style={{ fontSize: 12, minWidth: 62 }}>Teaching</span>
        {subjects.length === 0 ? (
          <span className="badge warn">No subjects yet</span>
        ) : (
          subjects.map((s) => {
            const who = teachersOf(s.id);
            const sectionsStudying = studiedBy(s.id);
            const partial = sectionsStudying.length > 0 && sectionsStudying.length < sections.length;
            return (
              <Link key={s.id} href={`/classes/${klass.id}`} style={{ textDecoration: 'none' }}
                title={
                  `${s.name} — ${who.length ? who.join(', ') : 'no teacher assigned'}`
                  + (partial ? ` · only Section ${sectionsStudying.map((x) => x.name).join(', ')}` : '')
                }>
                <span className={who.length ? 'badge ok' : 'badge warn'}>
                  {s.name} · {who.length ? who.join(', ') : 'unassigned'}{partial ? ' *' : ''}
                </span>
              </Link>
            );
          })
        )}
      </div>

      {(uncovered.length > 0 || classTeacherGaps.length > 0) && (
        <Link href={`/classes/${klass.id}`} style={{ fontSize: 12, color: '#b45309', textDecoration: 'none', fontWeight: 600 }}>
          ⚠{' '}
          {[
            uncovered.length > 0 && `${uncovered.length} subject${uncovered.length === 1 ? '' : 's'} without a teacher`,
            classTeacherGaps.length > 0 && `${classTeacherGaps.length} section${classTeacherGaps.length === 1 ? '' : 's'} without a class teacher`,
          ].filter(Boolean).join(' · ')}{' '}
          →
        </Link>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete class “${klass.name}”?`}
          body={
            sections.length || subjects.length
              ? `It has ${sections.length} section${sections.length === 1 ? '' : 's'} and ${subjects.length} subject${subjects.length === 1 ? '' : 's'}. Deleting is blocked while students, fees or exams depend on it.`
              : 'This class has no sections or subjects yet.'
          }
          confirmLabel="Delete class"
          onConfirm={onDelete}
          onClose={() => setPendingDelete(false)}
        />
      )}
    </div>
  );
}
