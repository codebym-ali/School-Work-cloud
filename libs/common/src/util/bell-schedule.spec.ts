import {
  BellDayError,
  composeBellDay,
  hhmmToMinutes,
  minutesToHhmm,
  teachingPeriodCount,
} from './bell-schedule';

describe('bell-schedule day composition', () => {
  it('walks the day forward from its start, so rows are contiguous by construction', () => {
    const rows = composeBellDay('08:00', [
      { isTeaching: false, label: 'Assembly', minutes: 15 },
      { isTeaching: true, minutes: 40 },
      { isTeaching: true, minutes: 40 },
      { isTeaching: false, label: 'Break', minutes: 15 },
      { isTeaching: true, minutes: 40 },
    ]);

    expect(rows.map((r) => [r.startTime, r.endTime])).toEqual([
      ['08:00', '08:15'],
      ['08:15', '08:55'],
      ['08:55', '09:35'],
      ['09:35', '09:50'],
      ['09:50', '10:30'],
    ]);
    // The property that matters more than any single value: no gap and no overlap, anywhere.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].startTime).toBe(rows[i - 1].endTime);
    }
  });

  it('numbers only the teaching rows, in order', () => {
    const rows = composeBellDay('08:00', [
      { isTeaching: true, minutes: 40 },
      { isTeaching: false, label: 'Break', minutes: 15 },
      { isTeaching: true, minutes: 40 },
      { isTeaching: true, minutes: 40 },
    ]);
    expect(rows.map((r) => r.periodNo)).toEqual([1, null, 2, 3]);
    expect(teachingPeriodCount(rows)).toBe(3);
    // The break interrupts the clock, never the numbering — period 2 follows period 1 even though
    // fifteen minutes of something else sits between them.
  });

  it('labels a teaching row by its number and never by free text', () => {
    const [teaching, brk] = composeBellDay('08:00', [
      { isTeaching: true, label: 'ignore me', minutes: 40 },
      { isTeaching: false, minutes: 10 },
    ]);
    expect(teaching.label).toBeNull();
    // An unnamed break is still a break — better a default than a blank band on the grid.
    expect(brk.label).toBe('Break');
  });

  it('refuses a day that would run past midnight, naming the row that does it', () => {
    expect(() =>
      composeBellDay('22:00', [
        { isTeaching: true, minutes: 60 },
        { isTeaching: true, minutes: 120 },
      ]),
    ).toThrow(BellDayError);

    try {
      composeBellDay('23:00', [{ isTeaching: true, minutes: 120 }]);
      throw new Error('should have thrown');
    } catch (e) {
      // "row 1" rather than "invalid duration": the caller has a list on screen and needs to know
      // which line to shorten.
      expect((e as Error).message).toMatch(/past midnight.*row 1/);
    }
  });

  it('allows a day that ends exactly at 23:59 — the boundary is a real value, not an off-by-one', () => {
    const rows = composeBellDay('23:00', [{ isTeaching: true, minutes: 59 }]);
    expect(rows[0].endTime).toBe('23:59');
  });

  it('clears a day when given no rows — how a school says it does not teach on Sunday', () => {
    expect(composeBellDay('08:00', [])).toEqual([]);
  });

  it('round-trips HH:MM, zero-padded so the strings sort chronologically', () => {
    expect(minutesToHhmm(hhmmToMinutes('08:05'))).toBe('08:05');
    expect(minutesToHhmm(hhmmToMinutes('23:59'))).toBe('23:59');
    expect(minutesToHhmm(0)).toBe('00:00');
    // The whole reason this column is text and not `time`: lexicographic order IS chronological
    // order, so ORDER BY start_time needs no conversion.
    expect(['10:00', '08:05', '09:35'].sort()).toEqual(['08:05', '09:35', '10:00']);
  });
});
