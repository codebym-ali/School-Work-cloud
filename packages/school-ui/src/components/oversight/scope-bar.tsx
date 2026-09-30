'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiGet, type Campus, type Klass, type Section } from '@sw/api-client';
import { useCampusLens, useMe } from '@sw/session';
import { classLabeller } from '@school/lib/labels';

export interface Scope { campusId: string | null; classId: string | null; sectionId: string | null }

const PARAM = { campusId: 'campus', classId: 'class', sectionId: 'section' } as const;

function readUrl(): Partial<Scope> {
  if (typeof window === 'undefined') return {};
  const q = new URLSearchParams(window.location.search);
  return { campusId: q.get(PARAM.campusId), classId: q.get(PARAM.classId), sectionId: q.get(PARAM.sectionId) };
}

/** Rewrites only our three params, in place — other params (a status filter, a page) survive, and no
 *  history entry per click. Read/written via `window` rather than `useSearchParams`, which would force every
 *  page using the bar under a Suspense boundary for no benefit. */
function writeUrl(s: Scope) {
  const url = new URL(window.location.href);
  for (const k of Object.keys(PARAM) as Array<keyof Scope>) {
    const v = s[k];
    if (v) url.searchParams.set(PARAM[k], v); else url.searchParams.delete(PARAM[k]);
  }
  window.history.replaceState(window.history.state, '', url);
}

const sum = (xs: Array<number | null | undefined>) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);

/**
 * Campus ▸ Class ▸ Section scope (Owner UX plan, Phase 1a / principle 2): how a director actually thinks —
 * branch, then class, then the child. One hook owns the state; `<ScopeBar>` renders it.
 *
 * - Seeds from the URL (a filtered view can be shared or reloaded), else from the shell's campus lens.
 * - Choosing a campus narrows classes; choosing a class narrows sections; a parent change clears children.
 * - A campus-bound user (campus admin, accountant…) is fixed to their own campus — the SERVER enforces that
 *   regardless; this only stops the bar offering a choice they cannot make.
 * - Counts are real: `Section.enrolled` summed upwards.
 */
export function useScope() {
  const me = useMe();
  const lens = useCampusLens();
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [classes, setClasses] = useState<Klass[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);
  const fixedCampusId = me?.campusId ?? null;
  const [scope, setScope] = useState<Scope>(() => {
    const u = readUrl();
    return { campusId: u.campusId ?? lens.campusId ?? null, classId: u.classId ?? null, sectionId: u.sectionId ?? null };
  });

  useEffect(() => {
    let alive = true;
    Promise.all([apiGet<Campus[]>('/campuses'), apiGet<Klass[]>('/classes'), apiGet<Section[]>('/sections')])
      .then(([c, k, s]) => { if (!alive) return; setCampuses(c); setClasses(k); setSections(s); })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  // A campus-bound user is always on their campus, whatever the URL said.
  const effective: Scope = useMemo(
    () => (fixedCampusId ? { ...scope, campusId: fixedCampusId } : scope),
    [scope, fixedCampusId],
  );

  const commit = useCallback((next: Scope) => {
    setScope(next);
    writeUrl(next);
  }, []);

  const setCampus = useCallback((campusId: string | null) => {
    if (fixedCampusId) return;
    commit({ campusId, classId: null, sectionId: null });
    if (lens.canChoose) lens.setCampus(campusId); // the bar IS the lens on this screen
  }, [commit, fixedCampusId, lens]);
  const setClass = useCallback((classId: string | null) => commit({ ...effective, classId, sectionId: null }), [commit, effective]);
  const setSection = useCallback((sectionId: string | null) => commit({ ...effective, sectionId }), [commit, effective]);
  const reset = useCallback(() => commit({ campusId: fixedCampusId ?? null, classId: null, sectionId: null }), [commit, fixedCampusId]);

  // When the global campus lens changes (top-bar dropdown), sync it into the local scope.
  useEffect(() => {
    if (fixedCampusId) return;
    setScope((prev) => {
      if (prev.campusId === (lens.campusId ?? null)) return prev;
      const next: Scope = { campusId: lens.campusId ?? null, classId: null, sectionId: null };
      writeUrl(next);
      return next;
    });
  }, [lens.campusId, fixedCampusId]);

  // Drop a stale child once the data is in (a class id from another campus, a section from another class).
  useEffect(() => {
    if (loading) return;
    const cls = classes.find((c) => c.id === effective.classId);
    const classOk = !effective.classId || (cls && (!effective.campusId || cls.campusId === effective.campusId));
    const sec = sections.find((s) => s.id === effective.sectionId);
    const sectionOk = !effective.sectionId || (sec && sec.classId === effective.classId);
    if (!classOk) commit({ ...effective, classId: null, sectionId: null });
    else if (!sectionOk) commit({ ...effective, sectionId: null });
  }, [loading, classes, sections, effective, commit]);

  return {
    scope: effective, setCampus, setClass, setSection, reset, loading,
    campuses, classes, sections, campusFixed: !!fixedCampusId,
  };
}

export type ScopeState = ReturnType<typeof useScope>;

/** Rendered bar. `children` sits at the right (search, a status filter…). */
export function ScopeBar({ state, children }: { state: ScopeState; children?: ReactNode }) {
  const { scope, campuses, classes, sections, campusFixed, loading, setCampus, setClass, setSection, reset } = state;

  const classesInScope = classes
    .filter((c) => !scope.campusId || c.campusId === scope.campusId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  const sectionsInScope = sections
    .filter((s) => s.classId === scope.classId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const classLabel = classLabeller(classesInScope, campuses);

  const enrolledIn = (classId: string) => sum(sections.filter((s) => s.classId === classId).map((s) => s.enrolled));
  const enrolledInCampus = (campusId: string) =>
    sum(classes.filter((c) => c.campusId === campusId).map((c) => enrolledIn(c.id)));
  const count = (n: number) => ` · ${n.toLocaleString('en-US')}`;

  const campusName = campuses.find((c) => c.id === scope.campusId)?.name;
  const narrowed = (!campusFixed && !!scope.campusId) || !!scope.classId || !!scope.sectionId;

  return (
    <div className="ov-scope" aria-busy={loading}>
      <div className="ov-scope-fields">
        <label className="ov-field">
          <span>Campus</span>
          {campusFixed || campuses.length <= 1 ? (
            <span className="ov-static">{campusName ?? campuses[0]?.name ?? '—'}</span>
          ) : (
            <select value={scope.campusId ?? ''} onChange={(e) => setCampus(e.target.value || null)}>
              <option value="">All campuses{count(sum(campuses.map((c) => enrolledInCampus(c.id))))}</option>
              {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}{count(enrolledInCampus(c.id))}</option>)}
            </select>
          )}
        </label>
        <label className="ov-field">
          <span>Class</span>
          <select value={scope.classId ?? ''} onChange={(e) => setClass(e.target.value || null)} disabled={loading}>
            <option value="">All classes</option>
            {classesInScope.map((c) => <option key={c.id} value={c.id}>{classLabel(c)}{count(enrolledIn(c.id))}</option>)}
          </select>
        </label>
        <label className="ov-field">
          <span>Section</span>
          <select value={scope.sectionId ?? ''} onChange={(e) => setSection(e.target.value || null)}
            disabled={!scope.classId} title={scope.classId ? undefined : 'Choose a class first'}>
            <option value="">{scope.classId ? 'All sections' : 'Choose a class first'}</option>
            {sectionsInScope.map((s) => <option key={s.id} value={s.id}>{s.name}{count(s.enrolled ?? 0)}</option>)}
          </select>
        </label>
        {narrowed && <button type="button" className="ov-link" onClick={reset}>Clear</button>}
      </div>
      {children && <div className="ov-scope-extra">{children}</div>}
    </div>
  );
}
