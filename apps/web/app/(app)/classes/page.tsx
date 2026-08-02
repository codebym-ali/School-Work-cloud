'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  api, apiGet, apiPost, ApiError,
  type AcademicYear, type Campus, type Klass, type Section, type Subject, type SubjectCatalogueEntry,
} from '@/lib/api';
import { useMe } from '@/lib/me-context';
import { subjectCatalogueFrom } from '@/lib/subject-match';
import { ClassManager } from './class-manager';

export default function ClassesPage() {
  const me = useMe();
  const isOwner = (me?.roles ?? []).includes('OWNER_ADMIN');
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [classes, setClasses] = useState<Klass[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [catalogue, setCatalogue] = useState<SubjectCatalogueEntry[]>([]);
  const [hasCurrentYear, setHasCurrentYear] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function reload() {
    const [c, k, s, sub, cat, y] = await Promise.all([
      apiGet<Campus[]>('/campuses'),
      apiGet<Klass[]>('/classes'),
      apiGet<Section[]>('/sections'),
      api.subjects.listAll().catch(() => [] as Subject[]),
      api.subjects.catalogue().catch(() => [] as SubjectCatalogueEntry[]),
      apiGet<AcademicYear[]>('/academic-years').catch(() => [] as AcademicYear[]),
    ]);
    setCampuses(c); setClasses(k); setSections(s); setSubjects(sub); setCatalogue(cat);
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

  const myCampuses = isOwner ? campuses : campuses.filter((c) => c.id === me?.campusId);
  const derivedCatalogue = subjectCatalogueFrom(subjects);
  const effectiveCatalogue = catalogue.length ? catalogue : derivedCatalogue;
  const seats = sections.reduce((n, s) => n + s.capacity, 0);
  const counted = sections.filter((s) => s.enrolled != null);
  const filled = counted.reduce((n, s) => n + (s.enrolled ?? 0), 0);

  return (
    <div className="stack">
      <div className="row">
        <h1>Classes</h1>
        <Link className="chip" href="/setup">⚙️ School setup</Link>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Every class, the sections inside it, and the subjects each one studies. A section is one
        classroom group with a fixed number of seats — students are admitted into a section.
      </p>

      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {/* First run. Setup no longer embeds class management, so this screen is the ONLY way a
          new school creates its first class — and a class cannot be created without a campus.
          Say which prerequisite is missing rather than showing a form that will fail. */}
      {loaded && myCampuses.length === 0 && (
        <div className="toast warn">
          No campus yet — a class has to belong to one.{' '}
          <Link href="/setup" style={{ fontWeight: 600 }}>Add a campus in School configuration →</Link>
        </div>
      )}
      {loaded && myCampuses.length > 0 && !hasCurrentYear && (
        <div className="toast warn">
          No current school year is set, so seats show capacity only and teachers cannot be
          assigned.{' '}
          <Link href="/setup" style={{ fontWeight: 600 }}>Set the year in School configuration →</Link>
        </div>
      )}

      {loaded && classes.length > 0 && (
        <div className="grid">
          <div className="metric"><div className="value">{classes.length}</div><div className="label">Classes</div></div>
          <div className="metric"><div className="value">{sections.length}</div><div className="label">Sections</div></div>
          <div className="metric" title="Students enrolled, against the total seats across every section">
            <div className="value">{counted.length ? `${filled} of ${seats}` : `— of ${seats}`}</div>
            <div className="label">Seats filled</div>
          </div>
          {/* "Distinct" is a programmer's word for de-duplicated, and the number contradicted
              the chips on screen (20 chips, 11 here) with nothing to explain the difference. */}
          <div className="metric" title="Different subject names across all classes — a subject taught in three classes counts once">
            <div className="value">{effectiveCatalogue.length}</div>
            <div className="label">Subjects taught</div>
          </div>
        </div>
      )}

      <div className="card stack">
        {!loaded ? (
          <p className="muted" style={{ margin: 0 }}>Loading…</p>
        ) : (
          <ClassManager
            classes={classes} sections={sections} subjects={subjects} campuses={myCampuses} catalogue={effectiveCatalogue}
            showTools
            onCreateClass={async (b) => {
              try {
                const created = await apiPost<Klass>('/classes', b);
                await reload();
                setMsg({ ok: true, text: 'Class added — now add its subjects' });
                return created.id;
              } catch (e) {
                setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not add the class' });
                return null;
              }
            }}
            onCreateSections={(classId, names, subjectChoice, capacity) =>
              run(
                () => Promise.all(names.map((name) => api.sections.create({ classId, name, capacity, ...subjectChoice }))),
                names.length === 1 ? 'Section added' : `${names.length} sections added`,
              )}
            onCreateSubjects={(classId, names) =>
              run(() => Promise.all(names.map((name) => api.subjects.create(classId, name))),
                names.length === 1 ? 'Subject added' : `${names.length} subjects added`)}
            onUpdateClass={(id, body) => run(() => api.classes.update(id, body), 'Class updated')}
            onDeleteClass={(id) => run(() => api.classes.remove(id), 'Class deleted')}
            onReorderClass={(updates) =>
              run(async () => {
                for (const u of updates) await api.classes.update(u.id, { order: u.order });
              }, 'Order updated')}
            onUpdateSection={(id, body) => run(() => api.sections.update(id, body), 'Section updated')}
            onDeleteSection={(id) => run(() => api.sections.remove(id), 'Section deleted')}
            onDeleteSubject={(id) => run(() => api.subjects.remove(id), 'Subject deleted')}
            onCreateSubjectInline={async (classId, name) => {
              try {
                const created = await api.subjects.create(classId, name);
                await reload();
                return created;
              } catch (e) {
                setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not add that subject' });
                return null;
              }
            }}
          />
        )}
      </div>
    </div>
  );
}
