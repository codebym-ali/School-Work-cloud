/**
 * Which setup step is next, as a pure function so the rule can be tested without a browser.
 *
 * ⚠️ Fees are step 4 (GAP-12). The wizard used to declare "Setup complete — you can admit students" once
 * classes existed; a new owner admitted students and then could not bill any of them.
 *
 * ⚠️ A price counts only if it is ACTIVE and for the CURRENT year. A class priced only for last year bills
 * nothing this year — which is exactly the moment a school finds out.
 */
export interface ReadinessInput {
  hasCampus: boolean;
  currentYearId: string | null;
  classIds: string[];
  /** Class ids that cannot take a student yet (no section or no subject). */
  classBlockers: string[];
  structures: Array<{ classId: string; isActive: boolean; academicYearId: string }>;
}

export function setupReadiness(i: ReadinessInput) {
  const hasYear = i.currentYearId !== null;
  const hasClass = i.classIds.length > 0;
  const classesReady = hasClass && i.classBlockers.length === 0;
  const unpricedClassIds = i.classIds.filter(
    (id) => !i.structures.some((f) => f.classId === id && f.isActive && f.academicYearId === i.currentYearId),
  );
  const feesReady = hasClass && hasYear && unpricedClassIds.length === 0;
  const done = [i.hasCampus, hasYear, classesReady, feesReady].filter(Boolean).length;
  const nextStep = !i.hasCampus ? 1 : !hasYear ? 2 : !classesReady ? 3 : !feesReady ? 4 : 0;
  return { hasYear, hasClass, classesReady, feesReady, unpricedClassIds, done, nextStep, complete: nextStep === 0 };
}
