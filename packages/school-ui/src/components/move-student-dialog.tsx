'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type Klass, type Section } from '@sw/api-client';

/**
 * Move a student to another class or section (Student Transfer Plan, X1).
 *
 * **A transfer is an administrative act with consequences, not an edit.** The API closes the
 * current enrolment and opens a new one, so the dialog's job is to make three things legible
 * *before* the click:
 *
 * - **what is changing** — 9-A → 9-B is a different act from Grade 9 → Grade 10;
 * - **whether there is room** — seats decide whether this is even possible, and the office should
 *   see that before choosing rather than after being refused;
 * - **what does NOT move** — attendance and marks stay with the closed enrolment. A user who
 *   expects the whole year to follow the child reports that as data loss.
 *
 * The API is the authority on all of it: campus scoping on both ends, and `sectionCapacityMode`.
 * This screen shows the same facts early so the refusal is rare, never instead of the check.
 */
export function MoveStudentDialog({ student, classes, sections, onClose, onDone, onError }: {
  // Deliberately narrower than `Student`: the dialog needs an id and a name and nothing else, so a
  // `StudentDetail` from the profile screen satisfies it without a second prop shape.
  student: { id: string; fullName: string };
  classes: Klass[]; sections: Section[]; onClose: () => void;
  onDone: (text: string) => void; onError: (text: string) => void;
}) {
  const [toClassId, setToClassId] = useState('');
  const [toSectionId, setToSectionId] = useState('');
  const [current, setCurrent] = useState<{ classId: string; sectionId: string } | null>(null);
  const [hardCap, setHardCap] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The cap is a school setting, and it decides whether a full section is refused or merely
    // warned about — so the dialog must not guess which.
    api.schoolSettings.get().then((x) => setHardCap(x.sectionCapacityMode === 'HARD')).catch(() => {});
    // `Student` on the row carries no placement, and the "Currently" line is the whole reason a
    // user can tell a correction from a mistake. One call, to the endpoint built for it.
    api.enrollments.list(`studentId=${student.id}&status=ACTIVE`)
      .then((p) => { const e = p.data[0]; if (e) setCurrent({ classId: e.classId, sectionId: e.sectionId }); })
      .catch(() => {});
  }, [student.id]);

  useEffect(() => { setToSectionId(''); }, [toClassId]);

  const name = (classId: string, sectionId: string) => {
    const c = classes.find((x) => x.id === classId)?.name;
    const sec = sections.find((x) => x.id === sectionId)?.name;
    return c && sec ? `${c}-${sec}` : c ?? '—';
  };
  const options = sections.filter((x) => x.classId === toClassId);
  const target = options.find((x) => x.id === toSectionId);
  const seatsTaken = target?.enrolled ?? 0;
  const full = Boolean(target && seatsTaken >= target.capacity);
  const sameSection = Boolean(current) && toSectionId === current!.sectionId;
  const canSubmit = Boolean(toSectionId) && !sameSection && !(full && hardCap) && !busy;

  async function submit() {
    setBusy(true);
    try {
      await api.enrollments.transfer(student.id, toSectionId);
      const klass = classes.find((c) => c.id === toClassId)?.name ?? '';
      onDone(`${student.fullName} moved to ${klass}-${target?.name ?? ''}`);
    } catch (e) {
      // Shown verbatim: the server says "Section is at capacity" or refuses the campus. Both are
      // things the office can act on; "Failed" is not.
      onError(e instanceof ApiError ? e.message : 'Could not move this student');
    } finally { setBusy(false); }
  }

  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0, fontSize: 17 }}>Move — {student.fullName}</h2>
        <button className="ghost small" onClick={onClose}>Close</button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        Currently <strong>{current ? name(current.classId, current.sectionId) : '…'}</strong>.
      </p>

      <div className="inline-form">
        <div style={{ minWidth: 170 }}><label>Class</label>
          <select value={toClassId} onChange={(e) => setToClassId(e.target.value)}>
            <option value="">Select…</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div style={{ minWidth: 190 }}><label>Section</label>
          <select value={toSectionId} onChange={(e) => setToSectionId(e.target.value)} disabled={!toClassId}>
            <option value="">Select…</option>
            {options.map((x) => (
              // Seats on the option itself: "38 of 40" read while choosing beats a refusal after.
              <option key={x.id} value={x.id}>
                {x.name} — {x.enrolled ?? 0} of {x.capacity} seats{(x.enrolled ?? 0) >= x.capacity ? ' · full' : ''}
              </option>
            ))}
          </select>
        </div>
        <button onClick={submit} disabled={!canSubmit} style={{ minHeight: 44 }}>
          {busy ? 'Moving…' : 'Move student'}
        </button>
      </div>

      {sameSection && (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>That is the section they are already in.</p>
      )}
      {full && (
        // ADVISORY is the school saying its class sizes are guidance, so the move is allowed and
        // warned about — exactly what admission does. HARD refuses, and says so before the click.
        <div className={`toast ${hardCap ? 'err' : 'warn'}`}>
          {hardCap
            ? `${target?.name} is full (${seatsTaken} of ${target?.capacity}). This school does not allow over-filling a section.`
            : `${target?.name} is over capacity (${seatsTaken} of ${target?.capacity}). Allowed here, but worth checking.`}
        </div>
      )}

      {/* Not a nicety: without it, a user expects the whole year to follow the child and reports
          the history staying behind as data loss. */}
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Attendance and marks already recorded stay with{' '}
        <strong>{current ? name(current.classId, current.sectionId) : 'their current class'}</strong>. Only today onwards moves.
      </p>
    </div>
  );
}
