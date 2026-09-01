'use client';

import { useState } from 'react';
import type { Section, Subject, SubjectCatalogueEntry, TeacherAssignment } from '@sw/api-client';
import { nearestSubject } from '@school/lib/subject-match';
import { ConfirmDialog } from '../confirm-dialog';

/**
 * The class's subject catalogue — the list a section picks from.
 *
 * It is a table rather than a row of chips because each subject carries facts worth reading
 * before you touch it (which sections study it, who teaches it) and two actions of very
 * different weight. As chips, the only affordance was a 12px destructive ✕, and **rename did
 * not exist at all** — so a typo like "Mathmetics" was permanent the moment an exam result
 * referenced it and blocked deletion.
 */
export function SubjectCatalogue({
  className, subjects, sections, assignments, catalogue, canEdit,
  onAdd, onRename, onRemove, onSetLoad,
}: {
  className: string;
  subjects: Subject[];
  sections: Section[];
  assignments: TeacherAssignment[];
  catalogue: SubjectCatalogueEntry[];
  canEdit: boolean;
  onAdd: (names: string[]) => Promise<string | null> | void;
  onRename: (id: string, name: string) => Promise<string | null> | void;
  onRemove: (id: string) => Promise<string | null> | void;
  /** `null` clears the allocation — distinct from allocating zero. */
  onSetLoad: (id: string, periodsPerWeek: number | null) => Promise<string | null> | void;
}) {
  const [input, setInput] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [warnings, setWarnings] = useState<{ typed: string; suggestion: string; classCount: number }[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Subject | null>(null);
  const [busy, setBusy] = useState(false);

  const listId = 'class-subject-catalogue';
  const parsed = Array.from(new Set(input.split(',').map((s) => s.trim()).filter(Boolean)));

  /** A section with no explicit list studies everything the class offers. */
  const studiedBy = (subjectId: string) =>
    sections.filter((s) => !s.subjectIds?.length || s.subjectIds.includes(subjectId));

  const teachersOf = (subjectId: string) =>
    Array.from(new Set(assignments.filter((a) => a.subjectId === subjectId).map((a) => a.teacherName)));

  async function submit() {
    if (!parsed.length) return;
    // Warn before creating a near-duplicate ("Mathmetics" next to "Mathematics"), which is how
    // a school ends up with two subjects that mean one thing and split its exam results.
    const found = parsed.flatMap((typed) => {
      const suggestion = nearestSubject(typed, catalogue.map((c) => c.name));
      if (!suggestion) return [];
      return [{ typed, suggestion, classCount: catalogue.find((c) => c.name === suggestion)?.classCount ?? 0 }];
    });
    if (found.length) { setWarnings(found); return; }
    await commit(parsed);
  }

  async function commit(names: string[]) {
    setBusy(true);
    try {
      await onAdd(names);
      setInput('');
      setWarnings(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <div className="row">
        <div className="stack" style={{ gap: 2 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Subjects</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            The subjects {className} offers. Each section studies all of them unless you choose
            otherwise for that section.
          </p>
        </div>
        <span className="muted" style={{ fontSize: 13 }}>
          {subjects.length} subject{subjects.length === 1 ? '' : 's'}
        </span>
      </div>

      {subjects.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          None yet. A class needs at least one subject before students can be admitted into it.
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Subject</th>
                {/* The load a coordinator allocates BEFORE placing anything on the grid. Advisory:
                    the timetable reports "Maths 4 of 6" and never refuses the seventh. */}
                <th style={{ width: 120 }}>Periods/week</th>
                <th>Studied by</th>
                <th>Teachers</th>
                {canEdit && <th style={{ width: 150 }}></th>}
              </tr>
            </thead>
            <tbody>
              {subjects.map((s) => {
                const studying = studiedBy(s.id);
                const teachers = teachersOf(s.id);
                const everySection = studying.length === sections.length;
                return (
                  <tr key={s.id}>
                    <td>
                      {renaming?.id === s.id ? (
                        <div className="inline-form" style={{ gap: 6 }}>
                          <input
                            autoFocus
                            style={{ minWidth: 140 }}
                            value={renaming.name}
                            onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && renaming.name.trim()) {
                                onRename(s.id, renaming.name.trim());
                                setRenaming(null);
                              }
                              if (e.key === 'Escape') setRenaming(null);
                            }}
                          />
                          <button
                            className="small"
                            type="button"
                            disabled={!renaming.name.trim() || renaming.name.trim() === s.name}
                            onClick={() => { onRename(s.id, renaming.name.trim()); setRenaming(null); }}
                          >
                            Save
                          </button>
                          <button className="ghost small" type="button" onClick={() => setRenaming(null)}>Cancel</button>
                        </div>
                      ) : (
                        <strong style={{ fontWeight: 600 }}>{s.name}</strong>
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <input
                          type="number" min={1} max={60}
                          aria-label={`Periods per week for ${s.name}`}
                          style={{ width: 76 }}
                          placeholder="—"
                          defaultValue={s.periodsPerWeek ?? ''}
                          onBlur={(e) => {
                            const raw = e.target.value.trim();
                            // Blank clears it. "Not allocated" is a real state and must stay
                            // reachable — otherwise the only way back from a wrong number is a
                            // different wrong number.
                            const next = raw === '' ? null : Math.max(1, Math.min(60, Number(raw) || 1));
                            if (next !== (s.periodsPerWeek ?? null)) onSetLoad(s.id, next);
                          }}
                        />
                      ) : (
                        <span className="muted">{s.periodsPerWeek ?? '—'}</span>
                      )}
                    </td>
                    <td className="muted" style={{ fontSize: 13 }}>
                      {sections.length === 0
                        ? 'No sections yet'
                        : everySection
                          ? `All ${sections.length} section${sections.length === 1 ? '' : 's'}`
                          : studying.length === 0
                            ? 'No section'
                            : studying.map((x) => x.name).join(', ')}
                    </td>
                    <td>
                      {teachers.length
                        ? <span className="chips">{teachers.map((t) => <span key={t} className="badge ok">{t}</span>)}</span>
                        : <span className="badge warn">Unassigned</span>}
                    </td>
                    {canEdit && (
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {renaming?.id !== s.id && (
                          <>
                            <button className="ghost small" type="button" onClick={() => setRenaming({ id: s.id, name: s.name })}>
                              Rename
                            </button>
                            <button
                              className="ghost small"
                              type="button"
                              style={{ marginLeft: 6, color: '#b91c1c' }}
                              onClick={() => setPendingDelete(s)}
                            >
                              Remove
                            </button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="inline-form">
            <div style={{ flex: 1, minWidth: 200 }}>
              <label>Add subject{parsed.length > 1 ? 's' : ''}</label>
              <input
                list={listId}
                value={input}
                onChange={(e) => { setInput(e.target.value); setWarnings(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
                placeholder="e.g. Mathematics, Physics, Urdu"
              />
              <span className="field-hint">Separate with commas to add several at once.</span>
            </div>
            <button type="button" disabled={!parsed.length || busy} onClick={() => void submit()}>
              {busy ? 'Adding…' : parsed.length > 1 ? `Add ${parsed.length} subjects` : 'Add subject'}
            </button>
          </div>

          {warnings && warnings.length > 0 && (
            <div className="stack" style={{ gap: 8, padding: 10, borderRadius: 8, background: '#fffbeb', border: '1px solid #fcd34d' }}>
              {warnings.map((w) => (
                <div key={w.typed} className="chips">
                  <span style={{ fontSize: 13 }}>
                    &ldquo;{w.typed}&rdquo; looks like &ldquo;{w.suggestion}&rdquo;, already used in{' '}
                    {w.classCount} class{w.classCount === 1 ? '' : 'es'}.
                  </span>
                  <button
                    className="ghost small"
                    type="button"
                    onClick={() => {
                      setInput(parsed.map((n) => (n === w.typed ? w.suggestion : n)).join(', '));
                      setWarnings(null);
                    }}
                  >
                    Use &ldquo;{w.suggestion}&rdquo;
                  </button>
                </div>
              ))}
              <div><button className="small" type="button" onClick={() => void commit(parsed)}>Add anyway</button></div>
            </div>
          )}
        </div>
      )}

      <datalist id={listId}>
        {catalogue.map((c) => <option key={c.name} value={c.name} />)}
      </datalist>

      {pendingDelete && (
        <ConfirmDialog
          title={`Remove “${pendingDelete.name}” from ${className}?`}
          body={
            teachersOf(pendingDelete.id).length
              ? `${teachersOf(pendingDelete.id).join(', ')} teach${teachersOf(pendingDelete.id).length === 1 ? 'es' : ''} this subject. Removal is also blocked while exam results or timetable slots reference it.`
              : 'Removal is blocked while exam results, teacher assignments or timetable slots reference this subject.'
          }
          confirmLabel="Remove subject"
          onConfirm={() => onRemove(pendingDelete.id)}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
