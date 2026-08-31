'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  api, apiGet, apiPost, ApiError,
  type CoverageGap,
  type AcademicYear, type Campus, type Klass, type Section, type Subject,
  type SubjectCatalogueEntry, type TeacherAssignment,
} from '@/lib/api';
import { useMe } from '@/lib/me-context';
import { hasAnyRole, isSchoolWideAdmin } from '@/lib/roles';
import { Metric, MetricFilter, MetricLink } from '@/components/metric';
import { useCampusLens } from '@/lib/campus-lens';
import { subjectCatalogueFrom } from '@/lib/subject-match';
import { AddClassForm } from './add-class-form';
import { ClassCard } from './class-card';

/**
 * The class register: what exists, what is unfinished, and who teaches what.
 *
 * This screen is deliberately read-mostly. It previously carried the add form, the class list,
 * the subject editor, the section editor and the section-subject picker in one 710-line
 * component that was ALSO rendered by School configuration with a different flag — so every
 * behaviour had two truths and opening any panel pushed every class below it down the page.
 * Editing now lives on the workbench (`/classes/[id]`); creating and ordering a class stay
 * here because they are about the list rather than about one class.
 */
export default function ClassesPage() {
  const me = useMe();
  const roles = me?.roles ?? [];
  const schoolWide = isSchoolWideAdmin(roles);
  const canEdit = hasAnyRole(roles, ['OWNER_ADMIN', 'CAMPUS_ADMIN']);

  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [classes, setClasses] = useState<Klass[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [catalogue, setCatalogue] = useState<SubjectCatalogueEntry[]>([]);
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [coverage, setCoverage] = useState<CoverageGap[]>([]);
  const [hasCurrentYear, setHasCurrentYear] = useState(true);
  const [search, setSearch] = useState('');
  const [onlyGaps, setOnlyGaps] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function reload() {
    const [c, k, s, sub, cat, y, a, cov] = await Promise.all([
      apiGet<Campus[]>('/campuses'),
      apiGet<Klass[]>('/classes'),
      apiGet<Section[]>('/sections'),
      api.subjects.listAll().catch(() => [] as Subject[]),
      api.subjects.catalogue().catch(() => [] as SubjectCatalogueEntry[]),
      apiGet<AcademicYear[]>('/academic-years').catch(() => [] as AcademicYear[]),
      api.teacherAssignments.list().catch(() => [] as TeacherAssignment[]),
      api.classes.coverage().catch(() => [] as CoverageGap[]),
    ]);
    setCampuses(c); setClasses(k); setSections(s); setSubjects(sub); setCatalogue(cat); setAssignments(a); setCoverage(cov);
    setHasCurrentYear(y.some((x) => x.isCurrent));
  }
  useEffect(() => { reload().catch(() => {}).finally(() => setLoaded(true)); }, []);

  async function run(fn: () => Promise<unknown>, ok: string): Promise<string | null> {
    try {
      await fn();
      await reload();
      setMsg({ ok: true, text: ok });
      return null;
    } catch (e) {
      const text = e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';
      setMsg({ ok: false, text });
      return text;
    }
  }

  // A campus-bound admin only works within their own campus (the API force-scopes anyway).
  const lens = useCampusLens();
  const myCampuses = schoolWide ? campuses : campuses.filter((c) => c.id === me?.campusId);
  // Grouping follows the lens: one branch when a director is lensed in, all when viewing All.
  const shownCampuses = lens.campusId ? myCampuses.filter((c) => c.id === lens.campusId) : myCampuses;

  /**
   * Every (section, subject) pair with no teacher this year, **counted per class**.
   *
   * ⚠️ Per class rather than one total, so the tile and the filter beneath it are the same
   * derivation: `gaps` is the sum of this map and the filter is "this map has a non-zero entry".
   * A separate expression for each is how a count comes to disagree with the list it opens.
   *
   * ⚠️ This whole computation is scheduled for deletion (IA1): `/staff` already receives the same
   * fact server-computed, so the product answers one question two ways. Keeping it in ONE function
   * is what makes that a single-line swap rather than a hunt.
   */
  /**
   * Which classes have an unassigned subject, and how many — **counted from the server's list**.
   *
   * ⚠️ This used to re-join sections × subjects × assignments in the browser to DECIDE what a gap
   * was: a second implementation of a fact `/staff` already computed server-side, so the two `24`s
   * agreed only by luck (audit Law 4). Now the server decides (`GET /classes/coverage`) and this
   * only counts the rows per class — the same thing `/staff` does with the same list. Counting a
   * provided list is presentation; re-deriving the fact was the defect.
   */
  const gapsByClass = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of coverage) m.set(g.classId, (m.get(g.classId) ?? 0) + 1);
    return m;
  }, [coverage]);
  const gaps = coverage.length;

  const query = search.trim().toLowerCase();
  const matches = (k: Klass) => {
    // ⚠️ `gapsByClass` is declared ABOVE this function on purpose. It was originally below, and the
    // page rendered fine until the filter was switched on: `onlyGaps && …` short-circuits while the
    // filter is off, so the temporal-dead-zone access never happened. One click turned the whole
    // screen white with `Cannot access 'gapsByClass' before initialization` — and tsc and eslint
    // both passed, because neither tracks TDZ through a closure. Found by clicking it.
    if (onlyGaps && !gapsByClass.has(k.id)) return false;
    if (!query) return true;
    const own = subjects.filter((s) => s.classId === k.id).map((s) => s.name).join(' ');
    const secs = sections.filter((s) => s.classId === k.id).map((s) => s.name).join(' ');
    return `${k.name} ${own} ${secs}`.toLowerCase().includes(query);
  };

  const groups = shownCampuses
    .map((c) => ({
      id: c.id,
      campus: c.name,
      items: classes.filter((k) => k.campusId === c.id && matches(k)).sort((a, b) => a.order - b.order),
    }))
    .filter((g) => g.items.length > 0);
  const totalMatched = groups.reduce((n, g) => n + g.items.length, 0);

  const seats = sections.reduce((n, s) => n + s.capacity, 0);
  const counted = sections.filter((s) => s.enrolled != null);
  const filled = counted.reduce((n, s) => n + (s.enrolled ?? 0), 0);
  const effectiveCatalogue = catalogue.length ? catalogue : subjectCatalogueFrom(subjects);


  /** Renumber a campus's classes so `order` stays 1..n after a move. */
  const resequence = (items: Klass[], from: number, to: number) => {
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next.map((k, i) => ({ id: k.id, order: i + 1 })).filter((u, i) => next[i].order !== u.order);
  };

  return (
    <div className="stack">
      <div className="row">
        <h1>Classes</h1>
        <Link className="chip" href="/setup">⚙️ School configuration</Link>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Every class, the sections inside it, and who teaches each subject. Open a class to change
        its subjects, sections or teachers.
      </p>

      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {/* First run. School configuration no longer embeds class management, so this screen is
          the ONLY way a new school creates its first class — and a class cannot exist without a
          campus. Name the missing prerequisite rather than showing a form destined to fail. */}
      {loaded && myCampuses.length === 0 && (
        <div className="toast warn">
          No campus yet — a class has to belong to one.{' '}
          <Link href="/setup" style={{ fontWeight: 600 }}>Add a campus in School configuration →</Link>
        </div>
      )}
      {loaded && myCampuses.length > 0 && !hasCurrentYear && (
        <div className="toast warn">
          No current school year is set, so seats show capacity only and teachers cannot be assigned.{' '}
          <Link href="/setup" style={{ fontWeight: 600 }}>Set the year in School configuration →</Link>
        </div>
      )}

      {loaded && classes.length > 0 && (
        <div className="grid">
          {/* ⚠️ Context, not entry points. "17 classes" opens the list you are already looking at,
              and seats is a ratio with no rows behind it. A tile that lifts under the cursor and
              then does nothing teaches people to stop trying the ones that work. */}
          <Metric label="Classes" value={classes.length} />
          <Metric label="Sections" value={sections.length} />
          <Metric label="Seats filled" value={counted.length ? `${filled} of ${seats}` : `— of ${seats}`} />
          <MetricLink label="Subjects taught" value={effectiveCatalogue.length} href="/subjects" />
          <MetricFilter
            label="Without a teacher" value={gaps} alert={gaps > 0}
            active={onlyGaps}
            title="Show only the classes with an unassigned subject"
            onClick={() => setOnlyGaps(!onlyGaps)}
          />
        </div>
      )}

      {canEdit && loaded && myCampuses.length > 0 && (
        <AddClassForm
          campuses={myCampuses}
          defaultCampusId={lens.campusId ?? undefined}
          classes={classes}
          subjects={subjects}
          onCreate={async (body, copySubjectsFrom) => {
            try {
              const created = await apiPost<Klass>('/classes', body);
              if (copySubjectsFrom) {
                const names = subjects.filter((s) => s.classId === copySubjectsFrom).map((s) => s.name);
                await Promise.all(names.map((n) => api.subjects.create(created.id, n)));
              }
              await reload();
              setMsg({ ok: true, text: 'Class added — open it to add sections and subjects' });
              return null;
            } catch (e) {
              const text = e instanceof ApiError ? e.message : 'Could not add the class';
              setMsg({ ok: false, text });
              return text;
            }
          }}
        />
      )}

      {/* Search earns a place at 8 classes, not at 3 — below that it occupies the slot the
          primary action should own, to solve a problem nobody has. */}
      {loaded && classes.length >= 8 && (
        <div className="inline-form">
          <div style={{ minWidth: 240 }}>
            <label>Search classes, sections or subjects</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. 9th, Biology, Section B" />
          </div>
          {query && <button className="ghost" type="button" onClick={() => setSearch('')}>Clear</button>}
          {query && <span className="muted" style={{ fontSize: 13 }}>{totalMatched} match{totalMatched === 1 ? '' : 'es'}</span>}
        </div>
      )}

      {!loaded ? (
        <div className="card"><p className="muted" style={{ margin: 0 }}>Loading…</p></div>
      ) : classes.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            No classes yet{myCampuses.length > 0 ? ' — add your first one above' : ''}. A class is a
            year group like “Nursery”, “Grade 1” or “9th”; each one holds sections, and students
            are admitted into a section.
          </p>
        </div>
      ) : totalMatched === 0 ? (
        <div className="card stack" style={{ gap: 8 }}>
          {/* ⚠️ Two filters can empty this list now, and the message has to name the one that did.
              "No class matches" with an empty search term reads as a fault; when the gap filter is
              what emptied the page, the honest answer is the good news that there are no gaps. */}
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {onlyGaps && !query
              ? 'Every class has a teacher for every subject — nothing to fix here.'
              : onlyGaps
                ? `No class with an unassigned subject matches “${search}”.`
                : `No class matches “${search}”.`}
          </p>
          {onlyGaps && (
            <div><button className="ghost small" onClick={() => setOnlyGaps(false)}>Show all classes</button></div>
          )}
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.id} className="stack" style={{ gap: 10 }}>
            {myCampuses.length > 1 && <div className="section-title">{g.campus}</div>}
            {g.items.map((k, index) => (
              <ClassCard
                key={k.id}
                klass={k}
                sections={sections.filter((s) => s.classId === k.id).sort((a, b) => a.name.localeCompare(b.name))}
                subjects={subjects.filter((s) => s.classId === k.id).sort((a, b) => a.name.localeCompare(b.name))}
                assignments={assignments.filter((a) => sections.some((s) => s.id === a.sectionId && s.classId === k.id))}
                canEdit={canEdit}
                onRename={(body) => run(() => api.classes.update(k.id, body), 'Class updated')}
                onDelete={() => run(() => api.classes.remove(k.id), 'Class deleted')}
                onMoveUp={canEdit && index > 0
                  ? () => run(async () => {
                      for (const u of resequence(g.items, index, index - 1)) await api.classes.update(u.id, { order: u.order });
                    }, 'Order updated')
                  : undefined}
                onMoveDown={canEdit && index < g.items.length - 1
                  ? () => run(async () => {
                      for (const u of resequence(g.items, index, index + 1)) await api.classes.update(u.id, { order: u.order });
                    }, 'Order updated')
                  : undefined}
              />
            ))}
          </div>
        ))
      )}
    </div>
  );
}
