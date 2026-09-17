import { setupReadiness } from './setup-readiness';

describe('setupReadiness', () => {
  const base = { hasCampus: true, currentYearId: 'y26', classIds: ['c1', 'c2'], classBlockers: [] as string[] };
  const price = (classId: string, over: Partial<{ isActive: boolean; academicYearId: string }> = {}) =>
    ({ classId, isActive: true, academicYearId: 'y26', ...over });

  it('is NOT complete with classes ready but no fees — the case that let a school admit and not bill', () => {
    const r = setupReadiness({ ...base, structures: [] });
    expect(r.classesReady).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.nextStep).toBe(4);
    expect(r.unpricedClassIds).toEqual(['c1', 'c2']);
  });

  it('is complete once every class has an active price for the current year', () => {
    expect(setupReadiness({ ...base, structures: [price('c1'), price('c2')] })).toMatchObject({ complete: true, done: 4 });
  });

  it("does not count last year's price or a switched-off one", () => {
    const r = setupReadiness({ ...base, structures: [price('c1', { academicYearId: 'y25' }), price('c2', { isActive: false })] });
    expect(r.unpricedClassIds).toEqual(['c1', 'c2']);
    expect(r.complete).toBe(false);
  });

  it('still orders the earlier steps first', () => {
    expect(setupReadiness({ ...base, hasCampus: false, structures: [] }).nextStep).toBe(1);
    expect(setupReadiness({ ...base, currentYearId: null, structures: [] }).nextStep).toBe(2);
    expect(setupReadiness({ ...base, classBlockers: ['c1'], structures: [price('c1'), price('c2')] }).nextStep).toBe(3);
  });

  it('does not report fees ready for a school with no classes', () => {
    expect(setupReadiness({ ...base, classIds: [], structures: [] }).feesReady).toBe(false);
  });
});
