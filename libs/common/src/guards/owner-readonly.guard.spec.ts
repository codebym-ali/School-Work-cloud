import { OwnerReadOnlyGuard } from './owner-readonly.guard';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { ErrorCodes } from '../errors/error-codes';

function ctx(method: string, roles: string[], writable?: boolean): [ExecutionContext, Reflector] {
  const req = { method, user: { roles } } as any;
  const handler = () => {};
  const klass = class {};
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => klass,
  } as unknown as ExecutionContext;
  const reflector = {
    getAllAndOverride: () => writable ?? undefined,
  } as unknown as Reflector;
  return [context, reflector];
}

describe('OwnerReadOnlyGuard', () => {
  it('allows GET for owner-only', () => {
    const [c, r] = ctx('GET', ['OWNER_ADMIN']);
    expect(new OwnerReadOnlyGuard(r).canActivate(c)).toBe(true);
  });

  it('blocks POST for owner-only on non-writable route', () => {
    const [c, r] = ctx('POST', ['OWNER_ADMIN'], false);
    expect(() => new OwnerReadOnlyGuard(r).canActivate(c)).toThrow(
      expect.objectContaining({ code: ErrorCodes.OWNER_READ_ONLY }),
    );
  });

  it('allows POST for owner-only on @OwnerWritable route', () => {
    const [c, r] = ctx('POST', ['OWNER_ADMIN'], true);
    expect(new OwnerReadOnlyGuard(r).canActivate(c)).toBe(true);
  });

  it('allows POST for owner + ops admin (multi-role)', () => {
    const [c, r] = ctx('POST', ['OWNER_ADMIN', 'OPERATIONS_ADMIN'], false);
    expect(new OwnerReadOnlyGuard(r).canActivate(c)).toBe(true);
  });

  it('allows POST for non-owner', () => {
    const [c, r] = ctx('POST', ['CAMPUS_ADMIN'], false);
    expect(new OwnerReadOnlyGuard(r).canActivate(c)).toBe(true);
  });

  it('allows when no user', () => {
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ method: 'POST' }) }),
      getHandler: () => () => {},
      getClass: () => class {},
    } as unknown as ExecutionContext;
    const reflector = { getAllAndOverride: () => undefined } as unknown as Reflector;
    expect(new OwnerReadOnlyGuard(reflector).canActivate(context)).toBe(true);
  });
});
