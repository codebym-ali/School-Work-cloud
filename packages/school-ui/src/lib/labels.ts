import type { Campus, Klass, Section } from '@sw/api-client';

/**
 * Option labels for class/section pickers. A multi-campus school can have two classes with
 * the same name (e.g. an "8th" in each campus), which renders identical, unpickable options.
 * These helpers append the campus **only when another class in the same list shares the
 * name**, so disambiguation shows up exactly where it's needed and adds no noise elsewhere
 * (e.g. a list already filtered to one campus stays plain).
 */
export function classLabeller(classes: Klass[], campuses: Campus[]): (c: Klass) => string {
  const campusById = new Map(campuses.map((x) => [x.id, x.name]));
  const nameCount = new Map<string, number>();
  for (const c of classes) nameCount.set(c.name, (nameCount.get(c.name) ?? 0) + 1);
  return (c) => {
    const campus = campusById.get(c.campusId);
    return (nameCount.get(c.name) ?? 0) > 1 && campus ? `${c.name} — ${campus}` : c.name;
  };
}

/**
 * Labels a section as "<class> — <section>", with the campus appended after the section
 * ("8th — A · Girls Campus") when the class name is shared, so the section stays readable.
 */
export function sectionLabeller(classes: Klass[], campuses: Campus[]): (s: Section) => string {
  const campusById = new Map(campuses.map((x) => [x.id, x.name]));
  const classById = new Map(classes.map((c) => [c.id, c]));
  const nameCount = new Map<string, number>();
  for (const c of classes) nameCount.set(c.name, (nameCount.get(c.name) ?? 0) + 1);
  return (s) => {
    const c = classById.get(s.classId);
    if (!c) return s.name;
    const base = `${c.name} — ${s.name}`;
    const campus = campusById.get(c.campusId);
    return (nameCount.get(c.name) ?? 0) > 1 && campus ? `${base} · ${campus}` : base;
  };
}
