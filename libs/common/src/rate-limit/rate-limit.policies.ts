/**
 * Rate-limit policies (blueprint §29). Each policy is a set of independent rules;
 * a request is denied if it exceeds *any* rule in the policy (e.g. login is bounded
 * both per-IP and per-account). Limits are enforced with a Redis sliding window.
 *
 *   login    5/IP/15min AND 10/user/1h
 *   refresh  60/user/1h
 *   parent reads   600/user/1h (result-day traffic)
 *   public   60/IP/min
 *   authenticated (default)  600/user/min
 *   manual SMS   100/school/h  (recipient/day cap enforced separately in the SMS service)
 */

/** What the limit is keyed on. `email`/`refreshToken` are derived per-request for pre-auth flows. */
export type RateLimitScope = 'ip' | 'user' | 'school' | 'email' | 'refreshToken';

export interface RateLimitRule {
  scope: RateLimitScope;
  /** Max requests permitted within the window. */
  limit: number;
  /** Sliding-window length in seconds. */
  windowSec: number;
}

export type RateLimitPolicyName =
  | 'public'
  | 'authenticated'
  | 'login'
  | 'refresh'
  | 'parentRead'
  | 'manualSms';

const MIN = 60;
const HOUR = 60 * 60;

export const RATE_LIMIT_POLICIES: Record<RateLimitPolicyName, readonly RateLimitRule[]> = {
  // Default applied to @Public routes with no explicit policy.
  public: [{ scope: 'ip', limit: 60, windowSec: MIN }],
  // Default applied to authenticated routes with no explicit policy.
  authenticated: [{ scope: 'user', limit: 600, windowSec: MIN }],
  login: [
    { scope: 'ip', limit: 5, windowSec: 15 * MIN },
    { scope: 'email', limit: 10, windowSec: HOUR },
  ],
  refresh: [{ scope: 'refreshToken', limit: 60, windowSec: HOUR }],
  parentRead: [{ scope: 'user', limit: 600, windowSec: HOUR }],
  manualSms: [{ scope: 'school', limit: 100, windowSec: HOUR }],
} as const;
