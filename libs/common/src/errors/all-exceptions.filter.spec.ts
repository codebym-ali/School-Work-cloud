import { HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppError } from './app.error';
import { ErrorCodes } from './error-codes';

/**
 * The filter is the last line before a client sees a response, and WS-A made it the safety net that stops
 * any un-translated Prisma error becoming a 500. These tests pin that mapping: a missed service pre-check
 * must degrade to a clean 4xx in the §25.1 envelope, never a 500 or a leaked stack.
 */
describe('AllExceptionsFilter', () => {
  const cls = { getId: () => 'req-1', get: () => undefined } as unknown as ClsService;
  const filter = new AllExceptionsFilter(cls);

  const run = (exception: unknown): { status: number; body: any } => {
    let status = 0;
    let body: unknown;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({ method: 'POST', url: '/api/v1/x', id: 'req-1' }),
      }),
    } as unknown as ArgumentsHost;
    filter.catch(exception, host);
    return { status, body: body as any };
  };

  const knownError = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('db error', { code, clientVersion: 'test', meta });

  it('maps P2002 (unique) → 409 CONFLICT and names the field without echoing the value', () => {
    const { status, body } = run(knownError('P2002', { target: ['name'] }));
    expect(status).toBe(HttpStatus.CONFLICT);
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.details).toEqual([{ field: 'name', issue: 'must be unique' }]);
    expect(body.error.message).not.toMatch(/db error/);
  });

  it('maps P2025 (not found) → 404 NOT_FOUND', () => {
    const { status, body } = run(knownError('P2025'));
    expect(status).toBe(HttpStatus.NOT_FOUND);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('maps P2003 (FK) → 409 CONFLICT', () => {
    const { status, body } = run(knownError('P2003'));
    expect(status).toBe(HttpStatus.CONFLICT);
    expect(body.error.code).toBe('CONFLICT');
  });

  it('maps a raw CHECK violation (P2010 / 23514) → 422', () => {
    const { status, body } = run(knownError('P2010', { code: '23514' }));
    expect(status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('leaves an unrecognised Prisma code as a generic 500 (no stack leak)', () => {
    const { status, body } = run(knownError('P2015'));
    expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body.error.message).toBe('Internal server error');
  });

  it('still honours an AppError thrown by a service (pre-check wins)', () => {
    const { status, body } = run(
      new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'A class named "9th" already exists.'),
    );
    expect(status).toBe(HttpStatus.CONFLICT);
    expect(body.error.message).toBe('A class named "9th" already exists.');
  });
});
