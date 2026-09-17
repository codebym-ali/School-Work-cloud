import { createHash } from 'node:crypto';

/**
 * Year-end promotion, decided as a pure function (GAP-03, plan foundation F4).
 *
 * Every rule about WHERE a student goes lives here, with no database, so each is unit-tested directly.
 * The service only loads the inputs (a fixed number of queries) and writes the result (batched).
 *
 * Defects in the previous `PromotionService` that this replaces:
 *  - B2 — the final class had no destination, so every final-year student errored "No next class" every
 *    year. They now COMPLETE (`EnrollmentStatus.COMPLETED`, which already existed and nothing wrote).
 *  - B3 — the next class was found by `order + 1` exactly; deleting one class broke promotion out of the
 *    class below it. Now the next HIGHER order in the same campus, whatever the gap.
 *  - B4 — the section fallback took any section of the next class, ignoring HARD capacity. Seats are now
 *    counted as students are placed, so a full section is never overfilled by the batch itself.
 */

export type PromotionAction = 'PROMOTE' | 'RETAIN' | 'WITHDRAW';
export type PlannedOutcome = 'PROMOTED' | 'RETAINED' | 'WITHDRAWN' | 'COMPLETED';

export interface PlanClass { id: string; campusId: string; order: number; name: string }
export interface PlanSection { id: string; classId: string; name: string; capacity: number }
export interface PlanEnrollment { id: string; studentId: string; studentName: string; campusId: string; classId: string; sectionId: string }

export interface PlanInput {
  enrollments: PlanEnrollment[];
  classes: PlanClass[];
  sections: PlanSection[];
  /** ACTIVE students already seated in each section for the TARGET year, before this plan. */
  seatedInTargetYear: Map<string, number>;
  /** Students who already have an ACTIVE enrolment in the target year — skipped, never moved twice. */
  alreadyPlaced: Set<string>;
  /** Students who owe for a period that has begun. */
  owing: Set<string>;
  /** Per-student choice; anything absent is PROMOTE. */
  overrides: Map<string, 'RETAIN' | 'WITHDRAW'>;
  requireFeeClearance: boolean;
  hardCapacity: boolean;
}

export interface PlanLine {
  enrollmentId: string;
  studentId: string;
  studentName: string;
  fromSectionId: string;
  outcome: PlannedOutcome | null;
  /** Where the new ACTIVE enrolment goes. Null for WITHDRAWN and COMPLETED (they leave the roster). */
  toSectionId: string | null;
  toClassId: string | null;
  /** Set when this student cannot be moved as planned; nothing is written for them. */
  blocked: string | null;
  /** Already in the target year — shown, not moved. */
  skipped: boolean;
}

export function planPromotion(input: PlanInput): PlanLine[] {
  const classById = new Map(input.classes.map((c) => [c.id, c]));
  const seats = new Map(input.seatedInTargetYear); // mutated as students are placed

  /** B3: the next class is the lowest order strictly above this one, in the same campus. */
  const nextClass = (from: PlanClass): PlanClass | null =>
    input.classes
      .filter((c) => c.campusId === from.campusId && c.order > from.order)
      .sort((a, b) => a.order - b.order)[0] ?? null;

  /**
   * B4: a section in `classId`, preferring the same name ("7-A" → "8-A"), then the one with most free seats.
   * Under HARD capacity a full section is never chosen; if none has room, the student is blocked by name.
   */
  const seatIn = (classId: string, preferredName: string): { id: string } | { blocked: string } => {
    const candidates = input.sections.filter((s) => s.classId === classId);
    if (candidates.length === 0) return { blocked: `${classById.get(classId)?.name ?? 'The next class'} has no section` };
    const free = (s: PlanSection) => s.capacity - (seats.get(s.id) ?? 0);
    const ordered = [...candidates].sort((a, b) => {
      if (a.name === preferredName && b.name !== preferredName) return -1;
      if (b.name === preferredName && a.name !== preferredName) return 1;
      return free(b) - free(a) || a.name.localeCompare(b.name);
    });
    const pick = input.hardCapacity ? ordered.find((s) => free(s) > 0) : ordered[0];
    if (!pick) return { blocked: `No free seat in ${classById.get(classId)?.name ?? 'the next class'}` };
    seats.set(pick.id, (seats.get(pick.id) ?? 0) + 1);
    return { id: pick.id };
  };

  // Stable order, so the same inputs always yield the same plan (and the same fingerprint).
  const ordered = [...input.enrollments].sort((a, b) => a.studentName.localeCompare(b.studentName) || a.studentId.localeCompare(b.studentId));
  const sectionName = new Map(input.sections.map((s) => [s.id, s.name]));

  return ordered.map((e) => {
    const base = { enrollmentId: e.id, studentId: e.studentId, studentName: e.studentName, fromSectionId: e.sectionId };
    if (input.alreadyPlaced.has(e.studentId)) {
      return { ...base, outcome: null, toSectionId: null, toClassId: null, blocked: null, skipped: true };
    }
    const choice = input.overrides.get(e.studentId) ?? 'PROMOTE';

    if (choice === 'WITHDRAW') {
      return { ...base, outcome: 'WITHDRAWN', toSectionId: null, toClassId: null, blocked: null, skipped: false };
    }
    if (input.requireFeeClearance && input.owing.has(e.studentId)) {
      return { ...base, outcome: null, toSectionId: null, toClassId: null, blocked: 'Fees are owed', skipped: false };
    }
    if (choice === 'RETAIN') {
      // Retained in the same class; a seat is still needed there for the new year.
      const seat = seatIn(e.classId, sectionName.get(e.sectionId) ?? '');
      return 'blocked' in seat
        ? { ...base, outcome: null, toSectionId: null, toClassId: null, blocked: seat.blocked, skipped: false }
        : { ...base, outcome: 'RETAINED', toSectionId: seat.id, toClassId: e.classId, blocked: null, skipped: false };
    }

    const from = classById.get(e.classId);
    const next = from ? nextClass(from) : null;
    if (!next) {
      // B2: the top class completes school rather than erroring every year.
      return { ...base, outcome: 'COMPLETED', toSectionId: null, toClassId: null, blocked: null, skipped: false };
    }
    const seat = seatIn(next.id, sectionName.get(e.sectionId) ?? '');
    return 'blocked' in seat
      ? { ...base, outcome: null, toSectionId: null, toClassId: null, blocked: seat.blocked, skipped: false }
      : { ...base, outcome: 'PROMOTED', toSectionId: seat.id, toClassId: next.id, blocked: null, skipped: false };
  });
}

/**
 * A fingerprint of what a plan will DO. The commit recomputes the plan and refuses if this differs.
 *
 * ⚠️ Optimistic concurrency for a human-paced review (F4): between preview and commit a student may be
 * admitted, moved, or pay their fees. Committing a roster the owner never saw would promote people they did
 * not review. Only decisions are hashed — not names — so a spelling correction does not invalidate a plan.
 */
export function planFingerprint(lines: PlanLine[]): string {
  const canonical = lines
    .map((l) => [l.enrollmentId, l.skipped ? 'SKIP' : l.outcome ?? 'BLOCKED', l.toSectionId ?? '-', l.blocked ?? '-'].join(':'))
    .sort()
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}
