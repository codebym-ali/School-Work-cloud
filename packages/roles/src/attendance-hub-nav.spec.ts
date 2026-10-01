import { canReach, groupedNav, navItemFor } from './index';

/**
 * The Attendance hub folds Leave requests, Cover and Staff Attendance into ONE sidebar entry — for the roles that
 * get the hub. Everyone else keeps exactly what they had, and no route becomes reachable by anyone new.
 */
const hrefs = (roles: string[]) => groupedNav(roles, undefined, true).flatMap((g) => g.items.map((i) => i.href));
const ABSORBED = ['/leaves', '/cover', '/staff-attendance'];

describe('Attendance hub navigation', () => {
  it.each([['OWNER_ADMIN'], ['CAMPUS_ADMIN'], ['OPERATIONS_ADMIN']])('%s sees one Attendance entry, not the screens it absorbed', (role) => {
    const list = hrefs([role]);
    expect(list).toContain('/attendance');
    for (const h of ABSORBED) expect(list).not.toContain(h);
  });

  it('an HR manager has no hub, so Staff Attendance stays in their sidebar', () => {
    const list = hrefs(['HR_MANAGER']);
    expect(list).toContain('/staff-attendance');
    expect(list).not.toContain('/attendance');
  });

  it('a teacher keeps the marking screen and nothing new', () => {
    const list = hrefs(['TEACHER']);
    expect(list).toContain('/attendance');
    for (const h of ABSORBED) expect(list).not.toContain(h);
  });

  it('the absorbed routes stay role-gated — hiding a link never widens access', () => {
    for (const h of ABSORBED) {
      expect(navItemFor(h)).toBeDefined();
      expect(canReach(['OWNER_ADMIN'], h)).toBe(true);
      expect(canReach(['CAMPUS_ADMIN'], h)).toBe(true);
      expect(canReach(['STUDENT'], h)).toBe(false);
    }
    // Leave approval and cover are owner/campus-admin decisions; a teacher still cannot open them.
    expect(canReach(['TEACHER'], '/leaves')).toBe(false);
    expect(canReach(['TEACHER'], '/cover')).toBe(false);
    expect(canReach(['HR_MANAGER'], '/staff-attendance')).toBe(true);
  });

  it('Staff Attendance no longer shares an icon with Leave requests', () => {
    expect(navItemFor('/staff-attendance')!.icon).not.toBe(navItemFor('/leaves')!.icon);
  });
});
