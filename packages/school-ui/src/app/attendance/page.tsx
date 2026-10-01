'use client';

import { useEffect, useRef, useState } from 'react';
import { api, apiGet, apiPost, ApiError, type Campus, type Enrollment, type Klass, type Section, type TeacherClass, type UnmarkedRegisters } from '@sw/api-client';
import { sectionLabeller } from '@school/lib/labels';
import { useCampusLens, useMe } from '@sw/session';
import { hasAnyRole } from '@sw/roles';
import { AttendanceHub } from './hub';
import { ReadOnlyRegister, RegisterEmptyState, RegisterFilters, WeekStrip } from './register-overview';

/** Roles that mark attendance across the school; everyone else marking is a teacher scoped to their own
 *  sections. Drives whether the section picker is fed by the school-wide list or by /teaching/my-classes. */
const SCHOOL_WIDE_ATTENDANCE_ROLES = ['OWNER_ADMIN', 'OPERATIONS_ADMIN', 'CAMPUS_ADMIN'];

interface DayCoverage { date: string; working: boolean; marked: number; expected: number; closedFor: string | null }

const STATUSES = ['PRESENT', 'ABSENT', 'LATE', 'HALF_DAY'];
/** Short codes for the register. A paper register in a Pakistani school already reads P / A / L,
 *  so these are the marks a teacher is transcribing rather than a new vocabulary to learn. */
const STATUS_SHORT: Record<string, string> = { PRESENT: 'P', ABSENT: 'A', LATE: 'L', HALF_DAY: '½' };
const STATUS_LABEL: Record<string, string> = { PRESENT: 'Present', ABSENT: 'Absent', LATE: 'Late', HALF_DAY: 'Half day', ON_LEAVE: 'On leave', NOT_MARKED: 'Not marked' };
/** Who may WRITE a student register (Owner UX plan, Phase 0.1): the class teacher marks; campus admin and
 *  the Ops Admin correct. The owner is read-only — mirrors the API gate on POST /attendance/bulk. */
const MARKING_ROLES = ['TEACHER', 'CAMPUS_ADMIN', 'OPERATIONS_ADMIN'];
/** A read-only register shows a child with no record as "Not marked" — never assumed present. */
const NOT_MARKED = 'NOT_MARKED';
/** Read-only status pill tone — the app's one status colour language. */
const STATUS_TONE: Record<string, string> = { PRESENT: 'ok', ABSENT: 'bad', LATE: 'warn', HALF_DAY: 'warn', ON_LEAVE: '', NOT_MARKED: '' };
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
 * Owner and campus admin get the Attendance hub (Today · Students · Staff); a teacher, and any other role that
 * may open this route, gets the register exactly as before. The hub's class view is this same register: read-only
 * for the owner (who never marks), the marking screen for a campus admin.
 */
export default function AttendancePage() {
  const me = useMe();
  if (!me) return <p className="muted">Loading…</p>;
  if (!hasAnyRole(me.roles, ['OWNER_ADMIN', 'CAMPUS_ADMIN'])) return <AttendanceRegister />;
  const viewOnly = !me.roles.some((r) => MARKING_ROLES.includes(r));
  return <AttendanceHub viewOnly={viewOnly} renderClass={(key) => <AttendanceRegister key={key} embedded />} />;
}

function AttendanceRegister({ embedded = false }: { embedded?: boolean }) {
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
  // Roster loading is automatic for someone who marks (below); these say where it is, so the screen is never blank.
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const latestRequest = useRef(0);
  // True once a mark has been changed and not yet saved — so a date or class change cannot silently throw it away.
  const dirty = useRef(false);
  const [unmarked, setUnmarked] = useState<UnmarkedRegisters | null>(null);
  // Today's outstanding registers, for the empty state. Separate from `unmarked` (the banner a dashboard deep link asks for).
  const [outstanding, setOutstanding] = useState<UnmarkedRegisters | null | 'unavailable'>(null);
  const [loaded, setLoaded] = useState(false);
  const restoredSection = useRef(false);
  const [myClasses, setMyClasses] = useState<TeacherClass[]>([]);
  const lens = useCampusLens();
  const me = useMe();
  // A pure teacher marks only the sections assigned to them. Sourcing the picker from
  // /teaching/my-classes (not the school-wide list) is defence in depth over the server scoping AND
  // clearer UX — no scrolling past sections they cannot mark, no picking one that would 403 on save.
  const schoolWide = !!me && me.roles.some((r) => SCHOOL_WIDE_ATTENDANCE_ROLES.includes(r));
  // Owner UX plan, Phase 0.1: only the class teacher marks; campus admin / Ops Admin correct. Anyone else
  // who can open this page (the owner) gets a READ-ONLY register — the API refuses their writes anyway.
  const canMark = !!me && me.roles.some((r) => MARKING_ROLES.includes(r));
  const readOnly = !!me && !canMark;

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
    // …and a day (the owner overview's heatmap opens one register on one date).
    const d = params.get('date');
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today()) setDate(d);
    // Arrived from the dashboard's "N registers not marked today" chip: show WHICH ones, or the
    // chip is a number that points at a page where you still have to go looking.
    if (params.get('unmarked')) {
      api.staff.unmarkedRegisters().then(setUnmarked).catch(() => {});
    }
    // The empty state offers the registers that need a look. Admins only: the API gives a teacher their own list.
    if (me && schoolWide) api.staff.unmarkedRegisters().then(setOutstanding).catch(() => setOutstanding('unavailable'));
  }, [me, schoolWide]); // eslint-disable-line react-hooks/exhaustive-deps

  // ⚠️ Whoever marks gets the roster the moment a section and a day are set — chosen, preselected, deep-linked or
  // stepped to. It used to wait for a "Load roster" click that nothing said was needed, and a preselected class
  // (one assignment, or the last one used) left the screen blank under a section that looked already done.
  // A date change reloads too: stepping to another day used to leave the PREVIOUS day's marks under the new date.
  useEffect(() => {
    if (readOnly || !sectionId) return;
    loadRoster(date, sectionId).catch(() => {});
  }, [sectionId, date, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadCoverage(sid = sectionId) {
    if (!sid) return setCoverage([]);
    try {
      setCoverage(await apiGet<DayCoverage[]>(`/attendance/coverage?sectionId=${sid}&session=${session}&days=${BACKFILL_DAYS}`));
    } catch {
      setCoverage([]); // the strip is an aid, never a blocker
    }
  }
  // Read-only viewers get the week strip and the whole register from one server read (`ReadOnlyRegister`).
  useEffect(() => { if (!readOnly) loadCoverage().catch(() => {}); }, [sectionId, session, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadRoster(d: string = date, sid: string = sectionId) {
    if (!sid) return;
    const request = ++latestRequest.current;
    setLoading(true);
    setLoadError(false);
    try {
      const enr = await apiGet<{ data: Enrollment[] }>(`/enrollments?sectionId=${sid}&status=ACTIVE`);
      const existing = await apiGet<Array<{ enrollmentId: string; status: string }>>(`/attendance?sectionId=${sid}&date=${d}`);
      // A newer request (another class or day picked meanwhile) owns the screen now; this answer is stale.
      if (request !== latestRequest.current) return;
      const m: Record<string, string> = {};
      // Marking defaults everyone to PRESENT (the teacher flips the exceptions). A READ-ONLY view must not:
      // a child with no record is "Not marked", never shown as present.
      for (const e of enr.data) m[e.id] = readOnly ? NOT_MARKED : 'PRESENT';
      for (const a of existing) m[a.enrollmentId] = a.status;
      // Set marks BEFORE rows: the editable table renders on `rows.length > 0`, so seeding
      // marks first ensures the <select>s never render (and can't be changed then clobbered)
      // before their backing state exists — otherwise a status picked during the gap between
      // these two setState calls is overwritten by this setMarks. (Same race we fixed in exams.)
      setMarks(m);
      setRows(enr.data);
      setMsg(null);
      setLoaded(true);
      dirty.current = false;
    } catch {
      if (request === latestRequest.current) setLoadError(true);
    } finally {
      if (request === latestRequest.current) setLoading(false);
    }
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
      if (res.failed === 0) dirty.current = false;
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
  // ⚠️ Only once the sections have LOADED. The campus filter is restored from storage a moment after this screen
  // mounts; acting before the list arrived saw "no visible sections" and wiped a section the link had just chosen.
  useEffect(() => {
    if (sectionId && schoolWide && sections.length > 0 && !visibleSections.some((s) => s.id === sectionId)) { setSectionId(''); setRows([]); setLoaded(false); }
  }, [lens.campusId, sections.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Start somewhere sensible: a link's section wins; else the one remembered for this session; else, if there is
  // only one section to choose from, that one. Runs once the picker has options. Never overrides a choice.
  useEffect(() => {
    if (restoredSection.current || sectionId || pickerOptions.length === 0) return;
    restoredSection.current = true;
    if (new URLSearchParams(window.location.search).get('sectionId')) return;
    let remembered: string | null = null;
    try { remembered = window.sessionStorage.getItem('sw.attendance.section'); } catch { /* storage blocked */ }
    // Inside the hub the class view always starts at the picker (and "needs attention" list): reopening the
    // last class there looked like the button had picked one for you. The memory is for the standalone register.
    const pick = (embedded ? null : pickerOptions.find((o) => o.id === remembered)) ?? (pickerOptions.length === 1 ? pickerOptions[0] : null);
    if (pick) setSectionId(pick.id);
  }, [pickerOptions.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!sectionId) return;
    try { window.sessionStorage.setItem('sw.attendance.section', sectionId); } catch { /* storage blocked */ }
  }, [sectionId]);

  const chooseSection = (id: string, d?: string) => {
    setSectionId(id); setRows([]); setLoaded(false); setMsg(null);
    if (d) setDate(d);
  };
  // Changing class or day reloads the roster, which would drop marks the teacher has not saved — ask first.
  const confirmDiscard = () => !dirty.current || window.confirm('You have attendance marked that is not saved yet. Discard it?');
  const pickDate = (d: string) => { if (d !== date && confirmDiscard()) setDate(d); };
  const pickSection = (id: string) => { if (id !== sectionId && confirmDiscard()) chooseSection(id); };
  const selectedLabel = pickerOptions.find((o) => o.id === sectionId)?.label ?? '';
  // Only registers in the campus being viewed; the server list is school-wide.
  const attention = outstanding && outstanding !== 'unavailable'
    ? { ...outstanding, sections: outstanding.sections.filter((s) => !lens.campusId || s.campusId === lens.campusId)
        .sort((a, b) => Number(a.partial) - Number(b.partial) || a.className.localeCompare(b.className) || a.sectionName.localeCompare(b.sectionName)) }
    : null;
  // Counted from what is on screen, so it cannot disagree with what Save is about to send.
  const tally = rows.reduce((acc, r) => {
    const m = marks[r.id] ?? 'PRESENT';
    return { ...acc, [m]: (acc[m] ?? 0) + 1 };
  }, {} as Record<string, number>);

  return (
    <div className="stack">
      {!embedded && <h1>Attendance</h1>}
      {readOnly && !embedded && (
        <p className="muted" style={{ margin: 0 }}>
          Read-only — your teachers mark the register.
        </p>
      )}
      {readOnly && embedded && (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Open any class&rsquo;s register for a day. For school-wide status, use the Overview tab.
        </p>
      )}
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
                onClick={() => { if (!confirmDiscard()) return; setSectionId(u.sectionId); setDate(today()); }}>
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
      {!readOnly && date !== today() && (
        <div className="toast warn">
          You&apos;re marking <b>{new Date(date).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</b>,
          not today. Absences will be recorded but <b>parents won&apos;t be texted</b> for a past date.
        </div>
      )}

      {/* The backfill bound is a MARKING rule; a viewer may look at any past day. */}
      <RegisterFilters options={pickerOptions} sectionId={sectionId} onSection={readOnly ? (id) => chooseSection(id) : pickSection}
        date={date} onDate={readOnly ? setDate : pickDate} min={readOnly ? undefined : earliest()} max={today()} today={today()}>
        {/* The roster loads by itself now; this only re-reads it (and keeps its old name for anyone who looks for it). */}
        {!readOnly && sectionId && (
          <button type="button" className="ghost small" onClick={() => loadRoster()} disabled={loading}>{loading ? 'Loading…' : 'Reload roster'}</button>
        )}
      </RegisterFilters>

      {!readOnly && (
        <WeekStrip days={coverage} selected={date} today={today()} onPick={pickDate}
          hint="Tap a day to fill it in. Absences on past days are recorded but parents aren’t texted." />
      )}

      {/* The class, the day, and how the register stands — so a teacher sees WHICH register this is and never a blank page. */}
      {!readOnly && sectionId && loading && rows.length === 0 && <span className="ov-skel" style={{ height: 140, display: 'block' }} />}
      {!readOnly && sectionId && loadError && (
        <div className="toast err" role="alert">
          Couldn’t load {selectedLabel || 'this class'}’s students.{' '}
          <button type="button" className="ghost small" onClick={() => loadRoster()}>Try again</button>
        </div>
      )}
      {!readOnly && sectionId && loaded && rows.length > 0 && (
        <div className="card stack" style={{ gap: 12 }}>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 18 }}>{selectedLabel || 'Register'}</h2>
              <p className="ov-sub" style={{ margin: '2px 0 0', fontSize: 13 }}>
                {new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })} · {rows.length} student{rows.length === 1 ? '' : 's'}
              </p>
            </div>
          </div>
          <div className="ov-kpis" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(88px, 1fr))' }} aria-live="polite">
            {[
              ['Present', tally.PRESENT ?? 0, ''], ['Absent', tally.ABSENT ?? 0, (tally.ABSENT ?? 0) > 0 ? 'is-bad' : ''],
              ['Late', tally.LATE ?? 0, (tally.LATE ?? 0) > 0 ? 'is-warn' : ''], ['Half day', tally.HALF_DAY ?? 0, ''],
              ...((tally.ON_LEAVE ?? 0) > 0 ? [['On leave', tally.ON_LEAVE ?? 0, '']] : []),
            ].map(([label, n, tone]) => (
              <div key={label as string} className="ov-kpi">
                <span className="ov-kpi-label">{label}</span>
                <span className={`ov-num ${tone}`} style={{ fontSize: 24 }}>{n}</span>
              </div>
            ))}
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>Everyone starts as Present. Tap <b>A</b>, <b>L</b> or <b>½</b> for the exceptions, then Save.</p>
        </div>
      )}

      {!sectionId && (
        <RegisterEmptyState readOnly={readOnly} date={date} today={today()} schoolWide={schoolWide} attention={attention}
          loading={outstanding === null} onPick={(id) => chooseSection(id, today())} />
      )}
      {readOnly && sectionId && <ReadOnlyRegister sectionId={sectionId} date={date} today={today()} onDate={setDate} />}

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
                        {readOnly ? (
                          <span className={`badge ${STATUS_TONE[mark] ?? ''}`}>{STATUS_LABEL[mark] ?? mark}</span>
                        ) : (
                        <div className="marks" role="group" aria-label={`Attendance for ${r.student?.fullName ?? 'student'}`}>
                          {STATUSES.map((sTatus) => (
                            <button
                              key={sTatus}
                              type="button"
                              className={`mark${mark === sTatus ? ' on' : ''} ${sTatus.toLowerCase()}`}
                              aria-label={STATUS_LABEL[sTatus]}
                              aria-pressed={mark === sTatus}
                              onClick={() => { dirty.current = true; setMarks((prev) => ({ ...prev, [r.id]: sTatus })); }}
                            >
                              {STATUS_SHORT[sTatus]}
                            </button>
                          ))}
                        </div>
                        )}
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
              {tally.ON_LEAVE ? ` · ${tally.ON_LEAVE} on leave` : ''}
              {tally[NOT_MARKED] ? ` · ${tally[NOT_MARKED]} not marked` : ''}
            </span>
            {!readOnly && <button onClick={save}>Save attendance</button>}
          </div>
        </>
      )}
      {sectionId && loaded && rows.length === 0 && <p className="muted">No students in this section yet - admit or move students into it first.</p>}
    </div>
  );
}
