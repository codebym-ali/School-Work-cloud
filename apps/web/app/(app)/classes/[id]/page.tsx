'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  api, apiGet, ApiError,
  type AcademicYear, type Campus, type Klass, type ManagedTeacher,
  type Section, type Subject, type SubjectCatalogueEntry, type TeacherAssignment,
} from '@/lib/api';
import { useMe } from '@/lib/me-context';
import { subjectCatalogueFrom } from '@/lib/subject-match';
import { SubjectCatalogue } from './subject-catalogue';
import { SectionList } from './section-list';
import { SectionPane } from './section-pane';

/**
 * The class workbench — everything about ONE class, and the only place any of it is edited.
 *
 * The Classes list used to be a report and six inline forms at once: opening a panel pushed
 * every class below it down the page, nothing was addressable by URL, and the class-centric
 * question ("who teaches 9-A Maths?") had no home at all. That work moved here, and the list
 * went back to being a list.
 *
 * The selected section lives in the URL (`?section=`), so the back button and a shared link
 * both work. It is read from `window.location.search` rather than `useSearchParams` — the same
 * precedent the attendance and teacher-marks screens follow, which avoids forcing a Suspense
 * boundary around the page.
 */
export default function ClassDetailPage() {
  const params = useParams();
  const router = useRouter();
  const me = useMe();
  const classId = String(params?.id ?? '');
  const canEdit = (me?.roles ?? []).some((r) => r === 'OWNER_ADMIN' || r === 'CAMPUS_ADMIN');

  const [klass, setKlass] = useState<Klass | null>(null);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [catalogue, setCatalogue] = useState<SubjectCatalogueEntry[]>([]);
  const [staff, setStaff] = useState<ManagedTeacher[]>([]);
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busyKey, setBusyKey] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [k, c, sec, sub, cat, st, y, a] = await Promise.all([
      apiGet<Klass[]>('/classes'),
      apiGet<Campus[]>('/campuses'),
      apiGet<Section[]>(`/sections?classId=${classId}`),
      api.subjects.list(classId),
      api.subjects.catalogue().catch(() => [] as SubjectCatalogueEntry[]),
      api.staff.list().catch(() => [] as ManagedTeacher[]),
      apiGet<AcademicYear[]>('/academic-years'),
      api.teacherAssignments.list(),
    ]);
    setKlass(k.find((x) => x.id === classId) ?? null);
    setCampuses(c); setSections(sec); setSubjects(sub); setCatalogue(cat);
    setStaff(st); setYears(y); setAssignments(a);
  }, [classId]);

  useEffect(() => { load().catch(() => {}).finally(() => setLoaded(true)); }, [load]);

  // Adopt the section named in the URL, including on back/forward navigation.
  useEffect(() => {
    const sync = () => setSelected(new URLSearchParams(window.location.search).get('section'));
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const currentYear = years.find((y) => y.isCurrent) ?? null;
  const teachers = useMemo(() => staff.filter((s) => s.staffType === 'TEACHER'), [staff]);
  // Assignments come back for the whole school; this page only speaks about its own sections.
  const mine = useMemo(
    () => assignments.filter((a) => sections.some((s) => s.id === a.sectionId)),
    [assignments, sections],
  );
  const selectedSection = sections.find((s) => s.id === selected) ?? null;

  function selectSection(id: string) {
    const next = id === selected ? null : id;
    setSelected(next);
    router.replace(next ? `/classes/${classId}?section=${next}` : `/classes/${classId}`, { scroll: false });
  }

  async function run(key: string, fn: () => Promise<unknown>, ok: string): Promise<string | null> {
    setBusyKey(key);
    try {
      await fn();
      await load();
      setMsg({ ok: true, text: ok });
      return null;
    } catch (e) {
      const text = e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';
      setMsg({ ok: false, text });
      return text;
    } finally {
      setBusyKey('');
    }
  }

  /** One teacher per (section, subject): replace rather than stack duplicates. */
  const assign = (sectionId: string, subjectId: string | null, staffId: string) => {
    const existing = mine.find((a) => a.sectionId === sectionId && (a.subjectId ?? null) === subjectId) ?? null;
    return run(`${sectionId}:${subjectId ?? 'homeroom'}`, async () => {
      if (existing) await api.teacherAssignments.remove(existing.id);
      if (staffId) {
        await api.teacherAssignments.create({
          staffId, academicYearId: currentYear!.id, sectionId,
          ...(subjectId ? { subjectId } : {}),
        });
      }
    }, staffId ? 'Teacher assigned' : 'Teacher removed');
  };

  if (!loaded) return <p className="muted">Loading…</p>;
  if (!klass) {
    return (
      <div className="stack">
        <h1>Class not found</h1>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          It may have been deleted, or belong to a campus you cannot see.
        </p>
        <div><Link className="chip" href="/classes">← Back to Classes</Link></div>
      </div>
    );
  }

  const campusName = campuses.find((c) => c.id === klass.campusId)?.name ?? '';
  const strength = sections.reduce((n, s) => n + (s.enrolled ?? 0), 0);
  const counted = sections.some((s) => s.enrolled != null);
  // Every (section, subject) pair that still needs a teacher — the same question the vacancy
  // board used to be typed by hand to answer, derived so it cannot go stale.
  const pairs = sections.flatMap((s) => {
    const studied = s.subjectIds?.length ? subjects.filter((x) => s.subjectIds!.includes(x.id)) : subjects;
    return studied.map((x) => ({ sectionId: s.id, subjectId: x.id }));
  });
  const gaps = pairs.filter((p) => !mine.some((a) => a.sectionId === p.sectionId && a.subjectId === p.subjectId)).length;

  return (
    <div className="stack">
      <div className="row">
        <div className="stack" style={{ gap: 2 }}>
          <h1 style={{ marginBottom: 0 }}>{klass.name}</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {campusName}{currentYear ? ` · ${currentYear.name}` : ''} · {sections.length} section{sections.length === 1 ? '' : 's'}
            {' · '}{subjects.length} subject{subjects.length === 1 ? '' : 's'}
            {counted && ` · ${strength} student${strength === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="chips">
          <Link className="chip" href="/classes">← Classes</Link>
          <button className="ghost small" type="button"
            onClick={() => router.push(`/students?campusId=${klass.campusId}&classId=${klass.id}`)}>
            View students
          </button>
        </div>
      </div>

      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {!currentYear && (
        <div className="toast err">
          No current school year — teaching is recorded against one, so{' '}
          <Link href="/setup" style={{ fontWeight: 600 }}>set the year in School configuration</Link> before assigning teachers.
        </div>
      )}
      {currentYear && teachers.length === 0 && (
        <div className="toast warn">
          No teachers on record yet. Add them under <Link href="/staff" style={{ fontWeight: 600 }}>Staff</Link>,
          then assign them to a section here.
        </div>
      )}
      {currentYear && teachers.length > 0 && gaps > 0 && (
        <div className="toast warn">
          {gaps} subject{gaps === 1 ? '' : 's'} across {sections.length} section{sections.length === 1 ? '' : 's'}{' '}
          {gaps === 1 ? 'has' : 'have'} no teacher. Open a section below to assign one.
        </div>
      )}

      <SubjectCatalogue
        className={klass.name}
        subjects={subjects}
        sections={sections}
        assignments={mine}
        catalogue={catalogue.length ? catalogue : subjectCatalogueFrom(subjects)}
        canEdit={canEdit}
        onAdd={(names) =>
          run('subjects', () => Promise.all(names.map((n) => api.subjects.create(classId, n))),
            names.length === 1 ? 'Subject added' : `${names.length} subjects added`)}
        onRename={(id, name) => run(`subject:${id}`, () => api.subjects.rename(id, name), 'Subject renamed')}
        onRemove={(id) => run(`subject:${id}`, () => api.subjects.remove(id), 'Subject removed')}
      />

      <SectionList
        sections={sections}
        subjects={subjects}
        assignments={mine}
        selectedId={selected}
        canEdit={canEdit}
        onSelect={selectSection}
        onAdd={(names, capacity, copyFromSectionId) =>
          run('sections', () => Promise.all(names.map((name) => api.sections.create({
            classId, name, capacity,
            ...(copyFromSectionId ? { copySubjectsFromSectionId: copyFromSectionId } : {}),
          }))), names.length === 1 ? 'Section added' : `${names.length} sections added`)}
      />

      {selectedSection && (
        <SectionPane
          section={selectedSection}
          klassName={klass.name}
          classSubjects={subjects}
          teachers={teachers}
          assignments={mine}
          hasCurrentYear={Boolean(currentYear)}
          canEdit={canEdit}
          busyKey={busyKey}
          onUpdate={(body) => run(`section:${selectedSection.id}`, () => api.sections.update(selectedSection.id, body), 'Section updated')}
          onDelete={async () => {
            const failure = await run(`section:${selectedSection.id}`, () => api.sections.remove(selectedSection.id), 'Section deleted');
            // Keeping a deleted section in the URL would reopen an empty pane on the next load.
            if (!failure) { setSelected(null); router.replace(`/classes/${classId}`, { scroll: false }); }
            return failure;
          }}
          onSetSubjects={(subjectIds) =>
            run(`section:${selectedSection.id}`, () => api.sections.setSubjects(selectedSection.id, subjectIds),
              'Subjects updated for this section')}
          onAssign={(subjectId, staffId) => assign(selectedSection.id, subjectId, staffId)}
          onCreateSubject={async (name) => {
            try {
              const created = await api.subjects.create(classId, name);
              await load();
              return created;
            } catch (e) {
              setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not add that subject' });
              return null;
            }
          }}
        />
      )}
    </div>
  );
}
