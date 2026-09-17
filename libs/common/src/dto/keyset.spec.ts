import { decodeKeysetCursor, encodeKeysetCursor, keysetOlderThan, toKeysetPage } from './keyset';

describe('keyset pagination', () => {
  const row = (id: string, at: string) => ({ id, createdAt: new Date(at) });

  it('round-trips a cursor', () => {
    const c = { at: '2026-09-16T10:00:00.000Z', id: 'b3' };
    expect(decodeKeysetCursor(encodeKeysetCursor(c))).toEqual(c);
  });

  it('treats no cursor as the first page', () => {
    expect(decodeKeysetCursor(undefined)).toBeNull();
    expect(keysetOlderThan(null)).toEqual({});
  });

  it('refuses a malformed cursor rather than silently returning the first page', () => {
    // A tampered cursor falling back to page one would look like the log "restarted" — refuse instead.
    expect(() => decodeKeysetCursor('not-base64-json')).toThrow('Invalid cursor');
    expect(() => decodeKeysetCursor(Buffer.from('{"at":"yesterday","id":"x"}').toString('base64url'))).toThrow('Invalid cursor');
    expect(() => decodeKeysetCursor(Buffer.from('{"id":"x"}').toString('base64url'))).toThrow('Invalid cursor');
  });

  it('breaks a createdAt tie on id, so the row after a tie is not skipped', () => {
    const at = '2026-09-16T10:00:00.000Z';
    expect(keysetOlderThan({ at, id: 'm' })).toEqual({
      OR: [{ createdAt: { lt: new Date(at) } }, { createdAt: new Date(at), id: { lt: 'm' } }],
    });
  });

  it('pages with limit+1 — a cursor only when more exist', () => {
    const rows = [row('c', '2026-09-16T10:00:03Z'), row('b', '2026-09-16T10:00:02Z'), row('a', '2026-09-16T10:00:01Z')];

    const full = toKeysetPage(rows, 2); // fetched 3 = limit + 1
    expect(full.data.map((r) => r.id)).toEqual(['c', 'b']);
    expect(decodeKeysetCursor(full.nextCursor!)).toEqual({ at: '2026-09-16T10:00:02.000Z', id: 'b' });

    const last = toKeysetPage(rows.slice(2), 2); // only 1 left
    expect(last.data.map((r) => r.id)).toEqual(['a']);
    expect(last.nextCursor).toBeNull();
  });
});
