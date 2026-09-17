import { chunk, resolveAudience, type AudienceRow } from './broadcast-audience';

const row = (studentId: string, phone: string | null, verified = true, optedOut = false): AudienceRow => ({
  studentId, guardian: phone === null ? null : { phone, verified, optedOut },
});

describe('resolveAudience', () => {
  it('texts a parent of three siblings once', () => {
    const a = resolveAudience([row('s1', '0300'), row('s2', '0300'), row('s3', '0300')]);
    expect(a.recipients).toEqual(['0300']);
    expect(a.students).toBe(3);
  });

  it('never texts an opted-out parent, even if verified', () => {
    const a = resolveAudience([row('s1', '0301', true, true)]);
    expect(a.recipients).toEqual([]);
    expect(a.skipped).toEqual({ noGuardian: 0, unverified: 0, optedOut: 1 });
  });

  it('skips unverified numbers and students with no guardian, and says so', () => {
    const a = resolveAudience([row('s1', '0302', false), row('s2', null), row('s3', '0303')]);
    expect(a.recipients).toEqual(['0303']);
    expect(a.skipped).toEqual({ noGuardian: 1, unverified: 1, optedOut: 0 });
  });

  it('counts a student listed twice once', () => {
    expect(resolveAudience([row('s1', '0304'), row('s1', '0304')]).students).toBe(1);
  });
});

describe('chunk', () => {
  it('splits into fixed-size pieces with a short tail', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});
