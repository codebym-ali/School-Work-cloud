import { attendancePercentFromStatuses, checkInStatus, isPastLocalTime, localHhMm, schoolDayStatus, workingDaysBetween } from './attendance';

describe('schoolDayStatus', () => {
  const SUNDAY = new Date('2026-09-27T00:00:00Z');
  const MONDAY = new Date('2026-09-28T00:00:00Z');
  const campuses = ['c1', 'c2'];

  it('a weekly-off day closes every campus, and wins over a holiday on the same day', () => {
    expect(schoolDayStatus(SUNDAY, ['SUNDAY'], [{ campusId: null, name: 'Eid' }], campuses))
      .toEqual({ open: false, reason: 'Weekly off', closedCampusIds: ['c1', 'c2'] });
  });

  it('an ordinary working day is open with nothing closed', () => {
    expect(schoolDayStatus(MONDAY, ['SUNDAY'], [], campuses)).toEqual({ open: true, reason: null, closedCampusIds: [] });
  });

  it('a school-wide holiday closes everything and names itself', () => {
    expect(schoolDayStatus(MONDAY, ['SUNDAY'], [{ campusId: null, name: 'Iqbal Day' }], campuses))
      .toEqual({ open: false, reason: 'Iqbal Day', closedCampusIds: ['c1', 'c2'] });
  });

  it('one campus shut, another open: the school is open and the shut campus is named', () => {
    expect(schoolDayStatus(MONDAY, ['SUNDAY'], [{ campusId: 'c2', name: 'Local strike' }], campuses))
      .toEqual({ open: true, reason: null, closedCampusIds: ['c2'] });
  });

  it('every campus shut by its own holiday: closed, with the shared name or a generic one', () => {
    expect(schoolDayStatus(MONDAY, ['SUNDAY'], [{ campusId: 'c1', name: 'Rain' }, { campusId: 'c2', name: 'Rain' }], campuses).reason).toBe('Rain');
    expect(schoolDayStatus(MONDAY, ['SUNDAY'], [{ campusId: 'c1', name: 'Rain' }, { campusId: 'c2', name: 'Strike' }], campuses))
      .toMatchObject({ open: false, reason: 'Holiday' });
  });

  it('a school with no campuses yet is still subject to the weekly off', () => {
    expect(schoolDayStatus(SUNDAY, ['SUNDAY'], [], []).open).toBe(false);
    expect(schoolDayStatus(MONDAY, ['SUNDAY'], [], []).open).toBe(true);
  });
});

/** Local wall-clock Date for today at HH:MM — `checkInStatus` reads local hours by design
 *  (`dayStartTime` is a wall-clock setting; prod runs TZ=Asia/Karachi). */
const at = (hh: number, mm: number) => {
  const d = new Date();
  d.setHours(hh, mm, 0, 0);
  return d;
};

describe('checkInStatus', () => {
  // The whole point of deriving this: a staff member presses one button and the clock decides.
  // If the caller could pick, they would be choosing their own payroll deduction.
  it('is PRESENT before the day starts', () => {
    expect(checkInStatus(at(7, 30), '08:00', 15)).toBe('PRESENT');
  });

  it('is PRESENT exactly on the day start', () => {
    expect(checkInStatus(at(8, 0), '08:00', 15)).toBe('PRESENT');
  });

  it('is PRESENT on the last minute of grace, and LATE one minute later', () => {
    // The boundary is inclusive on purpose — a rule that punished the final legal minute would
    // be argued over every morning.
    expect(checkInStatus(at(8, 15), '08:00', 15)).toBe('PRESENT');
    expect(checkInStatus(at(8, 16), '08:00', 15)).toBe('LATE');
  });

  it('honours a zero grace period', () => {
    expect(checkInStatus(at(8, 0), '08:00', 0)).toBe('PRESENT');
    expect(checkInStatus(at(8, 1), '08:00', 0)).toBe('LATE');
  });

  it('handles a non-round start time', () => {
    expect(checkInStatus(at(7, 45), '07:45', 10)).toBe('PRESENT');
    expect(checkInStatus(at(7, 56), '07:45', 10)).toBe('LATE');
  });
});

describe('workingDaysBetween', () => {
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

  it('excludes the weekly off', () => {
    // 2026-08-03 is a Monday; 2026-08-09 a Sunday.
    const days = workingDaysBetween(d('2026-08-03'), d('2026-08-09'), ['SUNDAY'], []);
    expect(days).toHaveLength(6);
    expect(days).not.toContain('2026-08-09');
  });

  it('excludes holidays as well, without double-counting one that falls on a weekly off', () => {
    const days = workingDaysBetween(d('2026-08-03'), d('2026-08-09'), ['SUNDAY'], ['2026-08-05', '2026-08-09']);
    expect(days).toHaveLength(5);
    expect(days).not.toContain('2026-08-05');
  });

  it('is inclusive of both ends and handles a single day', () => {
    expect(workingDaysBetween(d('2026-08-03'), d('2026-08-03'), ['SUNDAY'], [])).toEqual(['2026-08-03']);
  });

  it('returns nothing when the whole range is off', () => {
    expect(workingDaysBetween(d('2026-08-09'), d('2026-08-09'), ['SUNDAY'], [])).toEqual([]);
  });
});

describe('attendancePercentFromStatuses', () => {
  it('excludes approved leave from the denominator rather than counting it against you', () => {
    // {ON_LEAVE, ABSENT, HALF_DAY, LATE, PRESENT} → 2.5 credit over 4 countable = 63%.
    expect(attendancePercentFromStatuses(['ON_LEAVE', 'ABSENT', 'HALF_DAY', 'LATE', 'PRESENT'])).toBe(63);
  });

  it('is null when nothing is countable — "no records" is not "attended nothing"', () => {
    expect(attendancePercentFromStatuses([])).toBeNull();
    expect(attendancePercentFromStatuses(['ON_LEAVE'])).toBeNull();
  });
});

/**
 * G4 — the school's clock, not the server's.
 *
 * These use a FIXED instant rather than "now", because a test that reads the wall clock passes or
 * fails depending on when it runs — the same trap the day-close block fell into. A fixed instant
 * also lets a single moment be checked against several zones at once, which is the whole point.
 */
describe('local wall clock (G4)', () => {
  // 09:30 UTC. Karachi is +05:00 → 14:30. Dubai +04:00 → 13:30. London (in BST) → 10:30.
  const instant = new Date('2026-08-04T09:30:00Z');

  it('reads the hour in the zone it is given, not the process zone', () => {
    expect(localHhMm(instant, 'Asia/Karachi')).toBe('14:30');
    expect(localHhMm(instant, 'Asia/Dubai')).toBe('13:30');
    expect(localHhMm(instant, 'UTC')).toBe('09:30');
  });

  it('handles a zone observing DST, so offsets are never done by hand', () => {
    // 2026-08-04 is British Summer Time (+01:00). Hardcoding +00:00 would be wrong half the year,
    // which is exactly why this formats rather than arithmetics on an offset.
    expect(localHhMm(instant, 'Europe/London')).toBe('10:30');
    expect(localHhMm(new Date('2026-01-04T09:30:00Z'), 'Europe/London')).toBe('09:30');
  });

  it('midnight is 00:00, never 24:00', () => {
    // `hour12: false` yields "24" at midnight in some locales, which would sort ABOVE every
    // deadline and make a just-past-midnight tick look like the end of the day.
    expect(localHhMm(new Date('2026-08-04T19:00:00Z'), 'Asia/Karachi')).toBe('00:00');
  });

  it("decides a deadline on the school's clock — the same instant, two answers", () => {
    // 14:30 in Karachi is past a 13:00 close; 13:30 in Dubai is too; 10:30 in London is not.
    expect(isPastLocalTime(instant, '13:00', 'Asia/Karachi')).toBe(true);
    expect(isPastLocalTime(instant, '13:00', 'Asia/Dubai')).toBe(true);
    expect(isPastLocalTime(instant, '13:00', 'Europe/London')).toBe(false);
  });

  it('lateness follows the school too', () => {
    // Same moment: a Karachi school starting 08:00 is long past its grace; a London one is not.
    expect(checkInStatus(instant, '08:00', 15, 'Asia/Karachi')).toBe('LATE');
    expect(checkInStatus(instant, '10:00', 45, 'Europe/London')).toBe('PRESENT');
  });
});
