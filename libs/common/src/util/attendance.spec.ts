import { attendancePercentFromStatuses, checkInStatus, workingDaysBetween } from './attendance';

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
