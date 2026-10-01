import { canReach, feesHiddenFromMe, groupedNav, isFeeRoute } from './index';

const hrefs = (roles: string[], seesFees?: boolean) =>
  groupedNav(roles, undefined, true, seesFees).flatMap((g) => g.items.map((i) => i.href));

describe('campus admin fee visibility (the owner\'s choice)', () => {
  it('is on by default — nothing changes unless the owner turns it off', () => {
    expect(feesHiddenFromMe(['CAMPUS_ADMIN'], undefined)).toBe(false);
    expect(feesHiddenFromMe(['CAMPUS_ADMIN'], true)).toBe(false);
    expect(hrefs(['CAMPUS_ADMIN'])).toEqual(expect.arrayContaining(['/defaulters', '/fee-claims']));
  });

  it('when off, hides fees only from a campus admin whose sole money role is campus admin', () => {
    expect(feesHiddenFromMe(['CAMPUS_ADMIN'], false)).toBe(true);
    expect(feesHiddenFromMe(['CAMPUS_ADMIN', 'TEACHER'], false)).toBe(true);
    // Anyone who runs or oversees money is unaffected — Ops Admin covers CAMPUS_ADMIN but is not caught.
    for (const r of ['OWNER_ADMIN', 'ACCOUNTANT', 'OPERATIONS_ADMIN']) {
      expect(feesHiddenFromMe([r, 'CAMPUS_ADMIN'], false)).toBe(false);
    }
    expect(feesHiddenFromMe(['TEACHER'], false)).toBe(false);
  });

  it('removes the fee screens from a campus admin\'s menu and reach, and only those', () => {
    const h = hrefs(['CAMPUS_ADMIN'], false);
    expect(h).not.toContain('/defaulters');
    expect(h).not.toContain('/fee-claims');
    expect(h).toContain('/students');
    expect(canReach(['CAMPUS_ADMIN'], '/defaulters', undefined, false)).toBe(false);
    expect(canReach(['CAMPUS_ADMIN'], '/students', undefined, false)).toBe(true);
    expect(hrefs(['ACCOUNTANT'], false)).toContain('/fees');
    expect(hrefs(['OPERATIONS_ADMIN'], false)).toContain('/defaulters');
  });

  it('knows which routes are money routes', () => {
    expect(['/fees', '/fee-claims', '/defaulters', '/fees/plans'].every(isFeeRoute)).toBe(true);
    expect(isFeeRoute('/students')).toBe(false);
  });
});
