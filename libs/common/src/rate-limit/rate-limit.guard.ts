import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { TenantContext } from '../context/tenant-context';
import { IS_PUBLIC } from '../decorators/public.decorator';
import { AppError } from '../errors/app.error';
import { ErrorCodes } from '../errors/error-codes';
import type { RequestUser } from '../context/tenant-context';
import { RateLimitService } from './rate-limit.service';
import { RATE_LIMIT_POLICY, SKIP_RATE_LIMIT } from './rate-limit.decorator';
import {
  RATE_LIMIT_POLICIES,
  type RateLimitPolicyName,
  type RateLimitRule,
  type RateLimitScope,
} from './rate-limit.policies';

/** httpOnly refresh cookie name — mirrors auth.cookies.REFRESH_COOKIE (kept local to respect module boundaries). */
const REFRESH_COOKIE = 'refresh_token';

/**
 * Global rate-limit guard (blueprint §29). Runs immediately after JwtAuthGuard, so
 * `req.user` is present for authenticated routes (keyed per user) and absent for
 * @Public routes (keyed per IP). Policy resolution:
 *   1. explicit `@RateLimit(name)` on the handler/class, else
 *   2. `public`  for @Public routes, else
 *   3. `authenticated`.
 * A route may opt out with `@SkipRateLimit()`. On breach: 429 RATE_LIMITED with a
 * `Retry-After` header; tenant-scoped breaches are logged as a compromise signal.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly enabled: boolean;

  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimitService,
    private readonly tenant: TenantContext,
    @Inject(ENV) env: Env,
  ) {
    this.enabled = env.RATE_LIMIT_ENABLED;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.enabled) return true;

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT, targets)) return true;

    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: RequestUser }>();

    const explicit = this.reflector.getAllAndOverride<RateLimitPolicyName>(RATE_LIMIT_POLICY, targets);
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);
    const policy: RateLimitPolicyName = explicit ?? (isPublic ? 'public' : 'authenticated');

    let worst: { retryAfterSec: number; rule: RateLimitRule } | null = null;
    for (const rule of RATE_LIMIT_POLICIES[policy]) {
      const id = this.identifier(rule.scope, req);
      if (id === null) continue; // scope not keyable for this request → skip that rule
      const key = `rl:${policy}:${rule.scope}:${id}`;
      const { allowed, retryAfterSec } = await this.limiter.consume(key, rule.limit, rule.windowSec);
      if (!allowed && (worst === null || retryAfterSec > worst.retryAfterSec)) {
        worst = { retryAfterSec, rule };
      }
    }

    if (worst) {
      http.getResponse<Response>().setHeader('Retry-After', String(worst.retryAfterSec));
      const schoolId = this.tenant.schoolId;
      // Repeated tenant-level hits are a compromise indicator (§29) — surface them.
      this.logger.warn(
        `Rate limit exceeded: policy=${policy} scope=${worst.rule.scope} ` +
          `school=${schoolId ?? '-'} user=${req.user?.userId ?? '-'} ip=${req.ip ?? '-'} ` +
          `retryAfter=${worst.retryAfterSec}s`,
      );
      throw new AppError(
        ErrorCodes.RATE_LIMITED,
        HttpStatus.TOO_MANY_REQUESTS,
        'Too many requests — please retry later',
      );
    }
    return true;
  }

  /** Resolve the value a rule is keyed on, or null when it cannot be keyed for this request. */
  private identifier(scope: RateLimitScope, req: Request & { user?: RequestUser }): string | null {
    switch (scope) {
      case 'ip':
        return req.ip ?? null;
      case 'user':
        return req.user?.userId ?? null;
      case 'school':
        return this.tenant.schoolId ?? null;
      case 'email': {
        const email = (req.body as { email?: unknown } | undefined)?.email;
        if (typeof email !== 'string' || !email.trim()) return null;
        // Namespace by tenant: the same email can exist in two schools.
        return `${this.tenant.schoolId ?? '_'}:${email.trim().toLowerCase()}`;
      }
      case 'refreshToken': {
        const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
        if (!raw) return req.ip ?? null; // no token yet → fall back to IP
        return createHash('sha256').update(raw).digest('hex');
      }
      case 'feeLinkToken': {
        const token = (req.params as Record<string, string> | undefined)?.token;
        // No token in the path ⇒ nothing to key on. Falling back to the IP would silently merge
        // every tokenless request into one bucket; returning null just drops THIS rule, and the
        // policy's IP rule still applies.
        if (!token) return null;
        // Hashed: the raw token is a bearer credential and Redis keys end up in logs and dumps.
        return createHash('sha256').update(token).digest('hex');
      }
      default:
        return null;
    }
  }
}
