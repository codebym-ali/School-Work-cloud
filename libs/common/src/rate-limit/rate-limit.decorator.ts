import { SetMetadata } from '@nestjs/common';
import type { RateLimitPolicyName } from './rate-limit.policies';

/** Route metadata key carrying an explicit rate-limit policy name. */
export const RATE_LIMIT_POLICY = 'rateLimitPolicy';

/**
 * Apply a named rate-limit policy to a route (blueprint §29). Without it, routes
 * fall back to the `public` (IP) or `authenticated` (user) default in the guard.
 * e.g. `@RateLimit('login')` on the login handler.
 */
export const RateLimit = (policy: RateLimitPolicyName) => SetMetadata(RATE_LIMIT_POLICY, policy);

/** Route metadata key that opts a route out of rate limiting entirely. */
export const SKIP_RATE_LIMIT = 'skipRateLimit';

/** Exempt a route from rate limiting (e.g. health probes). */
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT, true);
