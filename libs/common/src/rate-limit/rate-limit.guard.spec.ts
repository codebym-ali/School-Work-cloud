import { HttpStatus, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { AppError } from '../errors/app.error';
import type { TenantContext } from '../context/tenant-context';
import type { Env } from '../config/env.schema';
import { RateLimitGuard } from './rate-limit.guard';
import type { RateLimitResult, RateLimitService } from './rate-limit.service';
import { RATE_LIMIT_POLICY, SKIP_RATE_LIMIT } from './rate-limit.decorator';
import { IS_PUBLIC } from '../decorators/public.decorator';

/** Records every consume() and returns a scripted verdict (allowed unless overridden per key). */
class FakeLimiter {
  calls: Array<{ key: string; limit: number; windowSec: number }> = [];
  deny: Record<string, RateLimitResult> = {};
  async consume(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
    this.calls.push({ key, limit, windowSec });
    return this.deny[key] ?? { allowed: true, remaining: limit - 1, retryAfterSec: 0 };
  }
}

/** Reflector stub returning route metadata from a fixed map. */
function reflectorFor(meta: Record<string, unknown>): Reflector {
  return {
    getAllAndOverride: (key: string) => meta[key],
  } as unknown as Reflector;
}

interface ReqShape {
  ip?: string;
  user?: { userId: string };
  body?: unknown;
  cookies?: Record<string, string>;
}

function build(meta: Record<string, unknown>, opts: { limiter?: FakeLimiter; enabled?: boolean; schoolId?: string } = {}) {
  const limiter = opts.limiter ?? new FakeLimiter();
  const tenant = { schoolId: opts.schoolId } as unknown as TenantContext;
  const env = { RATE_LIMIT_ENABLED: opts.enabled ?? true } as unknown as Env;
  const guard = new RateLimitGuard(reflectorFor(meta), limiter as unknown as RateLimitService, tenant, env);
  return { guard, limiter };
}

function ctxFor(req: ReqShape): { ctx: ExecutionContext; setHeader: jest.Mock } {
  const setHeader = jest.fn();
  const ctx = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ setHeader }),
    }),
  } as unknown as ExecutionContext;
  return { ctx, setHeader };
}

describe('RateLimitGuard', () => {
  it('is a no-op when disabled', async () => {
    const { guard, limiter } = build({}, { enabled: false });
    const { ctx } = ctxFor({ ip: '1.1.1.1' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(limiter.calls).toHaveLength(0);
  });

  it('skips routes marked @SkipRateLimit', async () => {
    const { guard, limiter } = build({ [SKIP_RATE_LIMIT]: true });
    const { ctx } = ctxFor({ ip: '1.1.1.1' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(limiter.calls).toHaveLength(0);
  });

  it('applies the login policy (per-IP and per-email) on @Public login', async () => {
    const { guard, limiter } = build(
      { [IS_PUBLIC]: true, [RATE_LIMIT_POLICY]: 'login' },
      { schoolId: 'school-1' },
    );
    const { ctx } = ctxFor({ ip: '9.9.9.9', body: { email: 'A@Demo.PK ' } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(limiter.calls).toEqual([
      { key: 'rl:login:ip:9.9.9.9', limit: 5, windowSec: 900 },
      { key: 'rl:login:email:school-1:a@demo.pk', limit: 10, windowSec: 3600 },
    ]);
  });

  it('defaults authenticated routes to a per-user limit', async () => {
    const { guard, limiter } = build({});
    const { ctx } = ctxFor({ ip: '9.9.9.9', user: { userId: 'user-7' } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(limiter.calls).toEqual([{ key: 'rl:authenticated:user:user-7', limit: 600, windowSec: 60 }]);
  });

  it('defaults @Public routes without a policy to a per-IP limit', async () => {
    const { guard, limiter } = build({ [IS_PUBLIC]: true });
    const { ctx } = ctxFor({ ip: '2.2.2.2' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(limiter.calls).toEqual([{ key: 'rl:public:ip:2.2.2.2', limit: 60, windowSec: 60 }]);
  });

  it('throws 429 with a Retry-After header on breach', async () => {
    const limiter = new FakeLimiter();
    limiter.deny['rl:login:ip:9.9.9.9'] = { allowed: false, remaining: 0, retryAfterSec: 42 };
    const { guard } = build({ [IS_PUBLIC]: true, [RATE_LIMIT_POLICY]: 'login' }, { limiter, schoolId: 's1' });
    const { ctx, setHeader } = ctxFor({ ip: '9.9.9.9', body: { email: 'a@b.pk' } });

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '42');
  });

  it('reports 429 status via AppError', async () => {
    const limiter = new FakeLimiter();
    limiter.deny['rl:public:ip:3.3.3.3'] = { allowed: false, remaining: 0, retryAfterSec: 5 };
    const { guard } = build({ [IS_PUBLIC]: true }, { limiter });
    const { ctx } = ctxFor({ ip: '3.3.3.3' });
    await guard.canActivate(ctx).catch((e: AppError) => {
      expect(e).toBeInstanceOf(AppError);
      expect(e.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    });
  });

  it('falls back to IP for the refresh policy when no refresh cookie is present', async () => {
    const { guard, limiter } = build({ [IS_PUBLIC]: true, [RATE_LIMIT_POLICY]: 'refresh' });
    const { ctx } = ctxFor({ ip: '4.4.4.4', cookies: {} });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // The key namespace is the scope name; the identifier falls back to the IP value.
    expect(limiter.calls).toEqual([{ key: 'rl:refresh:refreshToken:4.4.4.4', limit: 60, windowSec: 3600 }]);
  });
});
