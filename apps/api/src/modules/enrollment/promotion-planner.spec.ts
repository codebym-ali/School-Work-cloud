import { planFingerprint, planPromotion, type PlanInput } from './promotion-planner';

/** A small campus: Grade 1, Grade 2, (no Grade 3 — deleted), Grade 4 as the top class. */
function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    classes: [
      { id: 'g1', campusId: 'c', order: 1, name: 'Grade 1' },
      { id: 'g2', campusId: 'c', order: 2, name: 'Grade 2' },
      { id: 'g4', campusId: 'c', order: 4, name: 'Grade 4' },
      { id: 'other', campusId: 'd', order: 3, name: 'Other campus Grade 3' },
    ],
    sections: [
      { id: 'g1a', classId: 'g1', name: 'A', capacity: 30 },
      { id: 'g2a', classId: 'g2', name: 'A', capacity: 30 },
      { id: 'g2b', classId: 'g2', name: 'B', capacity: 30 },
      { id: 'g4a', classId: 'g4', name: 'A', capacity: 30 },
      { id: 'otherA', classId: 'other', name: 'A', capacity: 30 },
    ],
    enrollments: [],
    seatedInTargetYear: new Map(),
    alreadyPlaced: new Set(),
    owing: new Set(),
    overrides: new Map(),
    requireFeeClearance: true,
    hardCapacity: false,
    ...over,
  };
}
const enr = (studentId: string, classId: string, sectionId: string, name = studentId) =>
  ({ id: `e-${studentId}`, studentId, studentName: name, campusId: 'c', classId, sectionId });

describe('planPromotion', () => {
  it('promotes into the same-named section of the next class', () => {
    const [line] = planPromotion(input({ enrollments: [enr('s1', 'g1', 'g1a')] }));
    expect(line).toMatchObject({ outcome: 'PROMOTED', toClassId: 'g2', toSectionId: 'g2a', blocked: null });
  });

  it('B3: skips a gap in class order instead of breaking — Grade 2 goes to Grade 4 when Grade 3 was deleted', () => {
    const [line] = planPromotion(input({ enrollments: [enr('s1', 'g2', 'g2a')] }));
    expect(line).toMatchObject({ outcome: 'PROMOTED', toClassId: 'g4' });
  });

  it('never promotes across campuses, even when another campus has the next order', () => {
    const [line] = planPromotion(input({ enrollments: [enr('s1', 'g2', 'g2a')] }));
    expect(line.toClassId).not.toBe('other');
  });

  it('B2: the top class COMPLETES instead of erroring every year', () => {
    const [line] = planPromotion(input({ enrollments: [enr('s1', 'g4', 'g4a')] }));
    expect(line).toMatchObject({ outcome: 'COMPLETED', toSectionId: null, blocked: null });
  });

  it('blocks a student who owes, when the school requires clearance — and only then', () => {
    const owing = new Set(['s1']);
    expect(planPromotion(input({ enrollments: [enr('s1', 'g1', 'g1a')], owing }))[0]).toMatchObject({ outcome: null, blocked: 'Fees are owed' });
    expect(planPromotion(input({ enrollments: [enr('s1', 'g1', 'g1a')], owing, requireFeeClearance: false }))[0].outcome).toBe('PROMOTED');
  });

  it('lets a student who owes still be WITHDRAWN — leaving is not blocked by clearance', () => {
    const [line] = planPromotion(input({ enrollments: [enr('s1', 'g1', 'g1a')], owing: new Set(['s1']), overrides: new Map([['s1', 'WITHDRAW']]) }));
    expect(line).toMatchObject({ outcome: 'WITHDRAWN', blocked: null });
  });

  it('retains a student in their own class, in a seat for the new year', () => {
    const [line] = planPromotion(input({ enrollments: [enr('s1', 'g1', 'g1a')], overrides: new Map([['s1', 'RETAIN']]) }));
    expect(line).toMatchObject({ outcome: 'RETAINED', toClassId: 'g1', toSectionId: 'g1a' });
  });

  it('B4: under HARD capacity, fills the preferred section then overflows to one with room', () => {
    const plan = planPromotion(input({
      hardCapacity: true,
      sections: input().sections.map((s) => (s.id === 'g2a' ? { ...s, capacity: 1 } : s)),
      enrollments: [enr('s1', 'g1', 'g1a', 'Ali'), enr('s2', 'g1', 'g1a', 'Bilal')],
    }));
    expect(plan.map((l) => l.toSectionId)).toEqual(['g2a', 'g2b']);
  });

  it('B4: under HARD capacity with no seat anywhere, blocks by name rather than overfilling', () => {
    const plan = planPromotion(input({
      hardCapacity: true,
      sections: input().sections.map((s) => (s.classId === 'g2' ? { ...s, capacity: 0 } : s)),
      enrollments: [enr('s1', 'g1', 'g1a')],
    }));
    expect(plan[0]).toMatchObject({ outcome: null, blocked: 'No free seat in Grade 2' });
  });

  it('counts students already seated in the target year against capacity', () => {
    const plan = planPromotion(input({
      hardCapacity: true,
      sections: input().sections.map((s) => (s.classId === 'g2' ? { ...s, capacity: 5 } : s)),
      seatedInTargetYear: new Map([['g2a', 5], ['g2b', 5]]),
      enrollments: [enr('s1', 'g1', 'g1a')],
    }));
    expect(plan[0].blocked).toBe('No free seat in Grade 2');
  });

  it('skips a student already placed in the target year — idempotent on re-run', () => {
    const [line] = planPromotion(input({ enrollments: [enr('s1', 'g1', 'g1a')], alreadyPlaced: new Set(['s1']) }));
    expect(line).toMatchObject({ skipped: true, outcome: null });
  });

  it('blocks when the next class has no section at all', () => {
    const [line] = planPromotion(input({
      sections: input().sections.filter((s) => s.classId !== 'g2'),
      enrollments: [enr('s1', 'g1', 'g1a')],
    }));
    expect(line.blocked).toBe('Grade 2 has no section');
  });
});

describe('planFingerprint', () => {
  const base = input({ enrollments: [enr('s1', 'g1', 'g1a'), enr('s2', 'g1', 'g1a')] });

  it('is stable for the same decisions, whatever the input order', () => {
    const reversed = { ...base, enrollments: [...base.enrollments].reverse() };
    expect(planFingerprint(planPromotion(base))).toBe(planFingerprint(planPromotion(reversed)));
  });

  it('changes when the roster changes between preview and commit', () => {
    const more = { ...base, enrollments: [...base.enrollments, enr('s3', 'g1', 'g1a')] };
    expect(planFingerprint(planPromotion(base))).not.toBe(planFingerprint(planPromotion(more)));
  });

  it('changes when a decision changes — a student paying their fees unblocks them', () => {
    const owing = { ...base, owing: new Set(['s1']) };
    expect(planFingerprint(planPromotion(base))).not.toBe(planFingerprint(planPromotion(owing)));
  });

  it('does not change for a spelling correction — names are not decisions', () => {
    const renamed = { ...base, enrollments: base.enrollments.map((e) => ({ ...e, studentName: e.studentName.toUpperCase() })) };
    expect(planFingerprint(planPromotion(base))).toBe(planFingerprint(planPromotion(renamed)));
  });
});
