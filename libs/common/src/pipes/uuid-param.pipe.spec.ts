import { HttpStatus, type ArgumentMetadata } from '@nestjs/common';
import { AppError } from '../errors/app.error';
import { UuidParamPipe } from './uuid-param.pipe';

/**
 * The pipe's whole job is deciding what it is allowed to reject. Both halves matter:
 * letting a malformed id through is the 500 this exists to stop, and rejecting too
 * eagerly breaks `:token` routes and the nil-UUID rows in the permission matrix.
 */
describe('UuidParamPipe', () => {
  const pipe = new UuidParamPipe();
  const meta = (type: ArgumentMetadata['type'], data?: string): ArgumentMetadata =>
    ({ type, data, metatype: String }) as ArgumentMetadata;

  const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  describe('rejects a malformed id', () => {
    // 'undefined' is the literal that started this: a JS fixture interpolating an
    // undefined variable into the path, which read as a broken feature, not a broken test.
    it.each(['undefined', 'null', 'abc', '', '123', `${uuid}x`, uuid.replace(/-/g, '')])(
      '%p',
      (bad) => {
        expect(() => pipe.transform(bad, meta('param', 'id'))).toThrow(AppError);
      },
    );

    it('as a 400 in the §25.1 envelope, naming the offending param', () => {
      let thrown: AppError | undefined;
      try {
        pipe.transform('undefined', meta('param', 'campusId'));
      } catch (e) {
        thrown = e as AppError;
      }
      expect(thrown?.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(thrown?.code).toBe('VALIDATION_FAILED');
      expect(thrown?.details).toEqual([{ field: 'campusId', issue: 'must be a UUID' }]);
    });

    it('without echoing the value back', () => {
      expect(() => pipe.transform('<script>', meta('param', 'id'))).toThrow(
        /^Malformed identifier in path$/,
      );
    });
  });

  describe('passes through', () => {
    it('a well-formed uuid, unchanged', () => {
      expect(pipe.transform(uuid, meta('param', 'id'))).toBe(uuid);
    });

    it('uppercase — Postgres stores lowercase, but a client may echo either', () => {
      const upper = uuid.toUpperCase();
      expect(pipe.transform(upper, meta('param', 'studentId'))).toBe(upper);
    });

    // The reason this pipe is version-agnostic rather than ParseUUIDPipe({version:'4'}).
    // test/matrix drives most rows against the nil UUID as a deliberately absent id; a
    // v4 check would turn those 404s into 400s and lose the not-found/malformed distinction.
    it('the nil uuid — well-formed but non-existent is the service’s 404 to give', () => {
      const nil = '00000000-0000-0000-0000-000000000000';
      expect(pipe.transform(nil, meta('param', 'id'))).toBe(nil);
    });
  });

  describe('ignores params that are not entity ids', () => {
    // The only two non-id path params in the repo; a name-based rule is what keeps them working.
    it.each(['token', 'provider'])('%p', (name) => {
      expect(pipe.transform('not-a-uuid', meta('param', name))).toBe('not-a-uuid');
    });

    it('an unnamed @Param(), which receives the whole params object', () => {
      const all = { id: 'undefined' };
      expect(pipe.transform(all, meta('param'))).toBe(all);
    });

    it.each(['body', 'query', 'custom'] as const)('anything from %p', (type) => {
      expect(pipe.transform('undefined', meta(type, 'id'))).toBe('undefined');
    });
  });
});
