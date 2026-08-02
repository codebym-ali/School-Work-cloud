'use client';

import { useState } from 'react';
import type { Section, Subject, TeacherAssignment } from '@/lib/api';

/**
 * The class's sections as a table, and the form that adds more.
 *
 * They used to be chips, each carrying three interactive controls (open students, Edit,
 * Delete) inside one badge — a compound widget dressed as a tag, which at six sections wrapped
 * into an unreadable band of twelve buttons. Here each section is a row with its facts, and
 * everything you can do to it lives one click away in its own pane.
 */
export function SectionList({
  sections, subjects, assignments, selectedId, canEdit, onSelect, onAdd,
}: {
  sections: Section[];
  subjects: Subject[];
  assignments: TeacherAssignment[];
  selectedId: string | null;
  canEdit: boolean;
  onSelect: (id: string) => void;
  onAdd: (names: string[], capacity: number, copyFromSectionId: string | null) => Promise<string | null> | void;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [capacity, setCapacity] = useState('40');
  const [copyFrom, setCopyFrom] = useState('');
  const [busy, setBusy] = useState(false);

  const names = Array.from(new Set(input.split(',').map((s) => s.trim()).filter(Boolean)));
  const subjectCount = (s: Section) => (s.subjectIds?.length ? s.subjectIds.length : subjects.length);
  const classTeacher = (s: Section) =>
    assignments.find((a) => a.sectionId === s.id && a.subjectId === null)?.teacherName ?? null;
  const uncovered = (s: Section) => {
    const studied = s.subjectIds?.length ? subjects.filter((x) => s.subjectIds!.includes(x.id)) : subjects;
    return studied.filter((x) => !assignments.some((a) => a.sectionId === s.id && a.subjectId === x.id)).length;
  };

  async function submit() {
    if (!names.length) return;
    setBusy(true);
    try {
      await onAdd(names, Number(capacity) || 40, copyFrom || null);
      setInput('');
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <div className="row">
        <div className="stack" style={{ gap: 2 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Sections</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            One classroom group with a fixed number of seats. Students are admitted into a section.
          </p>
        </div>
        {canEdit && (
          <button className="small" type="button" onClick={() => setOpen((v) => !v)}>
            {open ? 'Cancel' : '+ Section'}
          </button>
        )}
      </div>

      {sections.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          No sections yet. A class needs at least one before a student can be admitted into it.
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr><th>Section</th><th>Seats</th><th>Subjects</th><th>Class teacher</th><th style={{ width: 96 }}></th></tr>
            </thead>
            <tbody>
              {sections.map((s) => {
                const taken = s.enrolled;
                const full = taken != null && taken >= s.capacity;
                const gaps = uncovered(s);
                const ct = classTeacher(s);
                const selected = s.id === selectedId;
                return (
                  <tr key={s.id} style={selected ? { background: '#eef2ff' } : undefined}>
                    <td>
                      <strong style={{ fontWeight: 600 }}>Section {s.name}</strong>
                      {selected && <span className="muted" style={{ fontSize: 12 }}> · open</span>}
                    </td>
                    <td>
                      <span className={full ? 'badge bad' : 'badge'}>
                        {taken ?? '—'} of {s.capacity}{full ? ' · full' : ''}
                      </span>
                    </td>
                    <td className="muted" style={{ fontSize: 13 }}>
                      {subjectCount(s)}
                      {/* Only the exception is worth saying: "same as the class" on every row was
                          noise that pushed elective splits into everyone's face. */}
                      {s.subjectIds?.length ? ' · own list' : ''}
                      {gaps > 0 && <span style={{ color: '#b45309' }}> · {gaps} unassigned</span>}
                    </td>
                    <td>{ct ? <span className="badge ok">{ct}</span> : <span className="badge warn">None</span>}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="ghost small" type="button" onClick={() => onSelect(s.id)}>
                        {selected ? 'Close' : 'Open'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && open && (
        <div className="stack" style={{ gap: 10, padding: 12, border: '1px solid #c7d2fe', borderRadius: 8 }}>
          <div className="inline-form">
            <div style={{ flex: 1, minWidth: 160 }}>
              <label>Section name{names.length > 1 ? 's' : ''}</label>
              <input
                autoFocus
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
                placeholder="e.g. A, B, C"
              />
              <span className="field-hint">Separate with commas to add several at once.</span>
            </div>
            <div style={{ maxWidth: 120 }}>
              <label>Seats each</label>
              <input type="number" min={1} max={200} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
            </div>
            {sections.length > 0 && subjects.length > 0 && (
              <div style={{ minWidth: 190 }}>
                <label>Subjects</label>
                <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                  <option value="">Same as the class</option>
                  {sections.map((s) => (
                    <option key={s.id} value={s.id}>Copy Section {s.name} ({subjectCount(s)})</option>
                  ))}
                </select>
              </div>
            )}
            <button type="button" disabled={!names.length || busy} onClick={() => void submit()}>
              {busy ? 'Adding…' : names.length > 1 ? `Add ${names.length} sections` : 'Add section'}
            </button>
          </div>
          <span className="muted" style={{ fontSize: 12 }}>
            You can change which subjects a section studies at any time — open it after it is created.
          </span>
        </div>
      )}
    </div>
  );
}
