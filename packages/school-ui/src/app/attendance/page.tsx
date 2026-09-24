'use client';

import { useEffect, useState } from 'react';
import { api, apiGet, apiPost, ApiError, type Campus, type Enrollment, type Klass, type Section, type TeacherClass, type UnmarkedRegisters } from '@sw/api-client';
import { sectionLabeller } from '@school/lib/labels';
import { useCampusLens, useMe } from '@sw/session';

/** Roles that mark attendance across the school; everyone else marking is a teacher scoped to their own
 *  sections. Drives whether the section picker is fed by the school-wide list or by /teaching/my-classes. */
const SCHOOL_WIDE_ATTENDANCE_ROLES = ['OWNER_ADMIN', 'OPERATIONS_ADMIN', 'CAMPUS_ADMIN'];

interface DayCoverage { date: string; working: boolean; marked: number; expected: number; closedFor: string | null }

const STATUSES = ['PRESENT', 'ABSENT', 'LATE', 'HALF_DAY'];
/** Short codes for the register. A paper register in a Pakistani school already reads P / A / L,
 *  so these are the marks a teacher is transcribing rather than a new vocabulary to learn. */
const STATUS_SHORT: Record<string, string> = { PRESENT: 'P', ABSENT: 'A', LATE: 'L', HALF_DAY: '½' };
const STATUS_LABEL: Record<string, string> = { PRESENT: 'Present', ABSENT: 'Absent', LATE: 'Late', HALF_DAY: 'Half day' };
const today = () => new Date().toISOString().slice(0, 10);
/** Mirrors the server's `attendanceBackfillDays` (default 7). Bounding the picker means the
 *  rule is visible as a disabled date rather than discovered as a rejected save. */
const BACKFILL_DAYS = 7;
const earliest = () => {
  const d = new Date();
  d.setDate(d.getDate() - BACKFILL_DAYS);
  return d.toISOString().slice(0, 10);
};

/**
 * The last 7 days at a glance, so a teacher can SEE which days are unmarked instead of
 * remembering them. Backfill without this is technically possible and practically unused —
 * nobody navigates date by date on the chance a day is missing.
 *
 * Non-working days are shown as "off", never as gaps: a strip that flags every Sunday is a
 * strip that gets ignored. A partly-marked day is called out separately from an untouched one
 * because they are different problems — one was interrupted, the other never started.
 */
function CoverageStrip({ days, selected, onPick }: {
  days: DayCoverage[]; selected: string; onPick: (date: string) => void;
}) {
  if (!days.length) return null;
  const gaps = days.filter((d) => d.working && d.marked < d.expected).length;

  return (
    <div className="card stack" style={{ gap: 8 }}>
      <div className="row">
        <strong style={{ fontSize: 14 }}>Last {days.length} days</strong>
        {gaps === 0
          ? <span className="badge ok">All marked</span>
          : <span className="badge warn">{gaps} day{gaps === 1 ? '' : 's'} need attention</span>}
      </div>
      <div className="chips">
        {days.map((d) => {
          const dt = new Date(`${d.date}T00:00:00`);
          const label = dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
          const isSel = d.date === selected;
          const complete = d.marked >= d.expected && d.expected > 0;
          const partial = d.marked > 0 && d.marked < d.expected;
          const state = !d.working ? 'off' : complete ? 'done' : partial ? 'partial' : 'missing';
          // Name the closure. "Holiday or weekly off" made a teacher wonder which, and why.
          const tip = !d.working ? (d.closedFor ?? 'Weekly off')
            : complete ? `All ${d.expected} marked`
            : partial ? `Only ${d.marked} of ${d.expected} marked`
            : `Not marked (${d.expected} students)`;
          return (
            <button
              key={d.date}
              type="button"
              className={`chip ${isSel ? 'active' : ''}`}
              disabled={!d.working}
              title={tip}
              onClick={() => onPick(d.date)}
              style={!isSel && d.working && state !== 'done' ? { borderColor: '#d97706' } : undefined}
            >
              {state === 'done' ? '✓' : state === 'off' ? '—' : '⚠'} {label}
              {state === 'partial' && <span className="muted" style={{ fontSize: 11 }}> {d.marked}/{d.expected}</span>}
            </button>
          );
        })}
      </div>
      {gaps > 0 && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Click a day to fill it in. Absences on past days are recorded but parents aren&apos;t texted.
        </p>
      )}
    </div>
  );
}

export default function AttendancePage() {
  const [classes, setClasses] = useState<Klass[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [sectionId, setSectionId] = useState('');
  const [date, setDate] = useState(today());
  const [session] = useState('MORNING');
  const [rows, setRows] = useState<Enrollment[]>([]);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [coverage, setCoverage] = useState<DayCoverage[]>([]);
  const [autoLoaded, setAutoLoaded] = useState(false);
  const [unmarked, setUnmarked] = useState<UnmarkedRegisters | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [myClasses, setMyClasses] = useState<TeacherClass[]>([]);
  const lens = useCampusLens();
  const me = useMe();
  // A pure teacher marks only the sections assigned to them. Sourcing the picker from
  // /teaching/my-classes (not the school-wide list) is defence in depth over the server scoping AND
  // clearer UX — no scrolling past sections they cannot mark, no picking one that would 403 on save.
  const schoolWide = !!me && me.roles.some((r) => SCHOOL_WIDE_ATTENDANCE_ROLES.includes(r));

  useEffect(() => {
    if (me && !schoolWide) {
      // Teacher: only their own sections. The school-wide lists would 403 for this role anyway.
      api.teaching.myClasses().then(setMyClasses).catch(() => {});
    } else if (me) {
      apiGet<Klass[]>('/classes').then(setClasses).catch(() => {});
      apiGet<Section[]>('/sections').then(setSections).catch(() => {});
      apiGet<Campus[]>('/campuses').then(setCampuses).catch(() => {});
    }
    // Deep-link from "My Classes" (e.g. /attendance?sectionId=…): preselect that section.
    const params = new URLSearchParams(window.location.search);
    const sid = params.get('sectionId');
    if (sid) setSectionId(sid);
    // Arrived from the dashboard's "N registers not marked today" chip: show WHICH ones, or the
    // chip is a number that points at a page where you still have to go looking.
    if (params.get('unmarked')) {
      api.staff.unmarkedRegisters().then(setUnmarked).catch(() => {});
    }
  }, [me, schoolWide]); // eslint-disable-line react-hooks/exhaustive-deps

  // Once the deep-linked section is set, load its roster automatically (one time).
  useEffect(() => {
    const sid = new URLSearchParams(window.location.search).get('sectionId');
    if (sid && sectionId === sid && !autoLoaded) {
      setAutoLoaded(true);
      loadRoster().catch(() => {});
    }
  }); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadCoverage(sid = sectionId) {
    if (!sid) return setCoverage([]);
    try {
      setCoverage(await apiGet<DayCoverage[]>(`/attendance/coverage?sectionId=${sid}&session=${session}&days=${BACKFILL_DAYS}`));
    } catch {
      setCoverage([]); // the strip is an aid, never a blocker
    }
  }
  useEffect(() => { loadCoverage().catch(() => {}); }, [sectionId, session]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadRoster(d: string = date) {
    if (!sectionId) return;
    const enr = await apiGet<{ data: Enrollment[] }>(`/enrollments?sectionId=${sectionId}&status=ACTIVE`);
    const existing = await apiGet<Array<{ enrollmentId: string; status: string }>>(`/attendance?sectionId=${sectionId}&date=${d}`);
    const m: Record<string, string> = {};
    for (const e of enr.data) m[e.id] = 'PRESENT';
    for (const a of existing) m[a.enrollmentId] = a.status;
    // Set marks BEFORE rows: the editable table renders on `rows.length > 0`, so seeding
    // marks first ensures the <select>s never render (and can't be changed then clobbered)
    // before their backing state exists — otherwise a status picked during the gap between
    // these two setState calls is overwritten by this setMarks. (Same race we fixed in exams.)
    setMarks(m);
    setRows(enr.data);
    setMsg(null);
    setLoaded(true);
  }

  async function save() {
    try {
      const records = rows.map((r) => ({ enrollmentId: r.id, status: marks[r.id] ?? 'PRESENT' }));
      const res = await apiPost<{ succeeded: number; failed: number; absenceQueued: number; absenceNotifiedSuppressed: number }>('/attendance/bulk', { sectionId, date, session, records });
      // Say plainly what happened to the notifications — a silently withheld SMS looks like a
      // bug to a teacher who expects parents to hear about an absence.
      const sms = res.absenceNotifiedSuppressed > 0
        ? `${res.absenceNotifiedSuppressed} absence(s) recorded — parents not texted for a past date`
        : `absence SMS queued ${res.absenceQueued}`;
      setMsg({ ok: res.failed === 0, text: `Saved ${res.succeeded}, failed ${res.failed}, ${sms}` });
      await loadCoverage(); // the day just filled should stop showing as a gap
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to save' });
    }
  }

  const sectionLabel = sectionLabeller(classes, campuses);
  // Show only the selected campus's sections — an owner viewing one campus should not scroll past
  // every other campus's rooms. A null lens ("All campuses") shows everything.
  const campusOfSection = (s: Section) => classes.find((c) => c.id === s.classId)?.campusId ?? null;
  const visibleSections = lens.campusId ? sections.filter((s) => campusOfSection(s) === lens.campusId) : sections;
  // The picker options: an admin sees the (campus-lensed) school-wide sections; a teacher sees only the
  // sections they are assigned to teach, de-duplicated (my-classes has one row per subject).
  const pickerOptions: Array<{ id: string; label: string }> = schoolWide
    ? visibleSections.map((s) => ({ id: s.id, label: sectionLabel(s) }))
    : Array.from(new Map(myClasses.map((c) => [c.sectionId, `${c.className} ${c.sectionName}`])).entries())
        .map(([id, label]) => ({ id, label }));
  useEffect(() => {
    if (sectionId && schoolWide && !visibleSections.some((s) => s.id === sectionId)) { setSectionId(''); setRows([]); setLoaded(false); }
  }, [lens.campusId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Counted from what is on screen, so it cannot disagree with what Save is about to send.
  const tally = rows.reduce((acc, r) => {
    const m = marks[r.id] ?? 'PRESENT';
    return { ...acc, [m]: (acc[m] ?? 0) + 1 };
  }, {} as Record<string, number>);

  return (
    <div className="stack">
      <h1>Attendance</h1>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {/* Surfaced, not enforced: this names the sections still outstanding and lets the reader
          jump straight into one. Nothing here blocks or punishes anybody. */}
      {unmarked && unmarked.count > 0 && (
        <div className="card stack" style={{ borderLeft: '4px solid #d97706' }}>
          <strong style={{ fontSize: 15 }}>
            {unmarked.count} register{unmarked.count === 1 ? '' : 's'} not marked today
          </strong>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Expected to be marked by {unmarked.markByTime}. Nothing is recorded for these students
            until someone marks them — an unmarked day stays a gap, it is never assumed.
          </p>
          <div className="row" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
            {unmarked.sections.map((u) => (
              <button key={u.sectionId} type="button" className="chip"
                onClick={() => { setSectionId(u.sectionId); setDate(today()); }}>
                {u.className} {u.sectionName}
                {/* Half-done and never-started are different problems needing different effort. */}
                {u.partial ? ` — ${u.marked}/${u.expected} done` : ''}
                {/* Who to chase. A covered register is still worth chasing, but the teacher who was
                    away could not have marked it (Cover Plan §6a). */}
                {u.coveredBy ? ` · ${u.coveredBy} covering` : ''} →
              </button>
            ))}
          </div>
        </div>
      )}
      {date !== today() && (
        <div className="toast warn">
          You&apos;re marking <b>{new Date(date).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</b>,
          not today. Absences will be recorded but <b>parents won&apos;t be texted</b> for a past date.
        </div>
      )}

      <div className="inline-form">
        <div><label>Section</label>
          <select aria-label="Section" value={sectionId} onChange={(e) => { setSectionId(e.target.value); setRows([]); setLoaded(false); setMsg(null); }}>
            <option value="">Select…</option>
            {pickerOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
        <div><label>Date</label>
          <input type="date" value={date} min={earliest()} max={today()}
            onChange={(e) => setDate(e.target.value)} />
        </div>
        <button className="ghost" onClick={() => loadRoster()} disabled={!sectionId}>Load roster</button>
      </div>

      <CoverageStrip days={coverage} selected={date} onPick={(d) => { setDate(d); loadRoster(d); }} />

      {rows.length > 0 && (
        <>
          {/*
            * The register (M2). Status was a `<select>` per student: two taps and a modal wheel on
            * a phone, for the single most repeated action a teacher performs. It is now four
            * buttons — one tap, and the current mark is visible without opening anything.
            *
            * P / A / L / ½ rather than words because four full labels do not fit across 375px, and
            * because a paper register in a Pakistani school is already marked in exactly these
            * letters. Each carries an `aria-label` with the full word.
            *
            * One markup for both sizes: CSS stacks the rows into cards below 720px rather than a
            * second phone-only list, which would be two things to keep in step.
            */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="register">
              <thead><tr><th>GR</th><th>Student</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const mark = marks[r.id] ?? 'PRESENT';
                  return (
                    <tr key={r.id}>
                      <td data-label="GR">{r.student?.grNumber}</td>
                      <td data-label="Student"><span className="who-name">{r.student?.fullName}</span></td>
                      <td>
                        <div className="marks" role="group" aria-label={`Attendance for ${r.student?.fullName ?? 'student'}`}>
                          {STATUSES.map((sTatus) => (
                            <button
                              key={sTatus}
                              type="button"
                              className={`mark${mark === sTatus ? ' on' : ''} ${sTatus.toLowerCase()}`}
                              aria-label={STATUS_LABEL[sTatus]}
                              aria-pressed={mark === sTatus}
                              onClick={() => setMarks((prev) => ({ ...prev, [r.id]: sTatus }))}
                            >
                              {STATUS_SHORT[sTatus]}
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/*
            * Sticky on a phone, inline on desktop. The count is not decoration: everyone starts
            * PRESENT, so a teacher who has flipped three names wants to see "3 absent" before
            * committing — it is the only check available that the register says what they meant.
            */}
          <div className="save-bar">
            {/* `?? 0`: an absent count of zero is absent from the tally object, and rendering it
                raw produced "5 present · absent". Zero is the answer a teacher most wants stated. */}
            <span className="tally">
              {tally.PRESENT ?? 0} present · {tally.ABSENT ?? 0} absent
              {tally.LATE ? ` · ${tally.LATE} late` : ''}
              {tally.HALF_DAY ? ` · ${tally.HALF_DAY} half-day` : ''}
            </span>
            <button onClick={save}>Save attendance</button>
          </div>
        </>
      )}
      {sectionId && loaded && rows.length === 0 && <p className="muted">No students in this section yet - admit or move students into it first.</p>}
    </div>
  );
}
