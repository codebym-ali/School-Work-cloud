import { z } from 'zod';

/**
 * Environment validation (blueprint §34: fail fast on misconfig).
 * Parsed once at boot; the app refuses to start with an invalid/missing var.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3000),

  APP_APEX_DOMAIN: z.string().min(1),
  RESERVED_SUBDOMAINS: z
    .string()
    // ⚠️ `s3` included: object storage is served at `s3.<apex>`, so a school registering that
    // subdomain would take over the host every presigned upload URL points at.
    .default('www,api,admin,app,s3')
    .transform((s) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)),

  DATABASE_URL: z.string().url(),
  PLATFORM_DATABASE_URL: z.string().url(),
  MIGRATION_DATABASE_URL: z.string().url().optional(),

  REDIS_URL: z.string().url(),

  JWT_ACTIVE_KID: z.string().min(1),
  // JSON map of { kid: secret }. Two keys active during quarterly rotation (§22.1).
  JWT_KEYS: z
    .string()
    .transform((s, ctx) => {
      try {
        const parsed = JSON.parse(s) as Record<string, string>;
        if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
          throw new Error('empty');
        }
        return parsed;
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'JWT_KEYS must be a non-empty JSON object' });
        return z.NEVER;
      }
    }),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((s) => s.toLowerCase() === 'true'),
  COOKIE_DOMAIN: z.string().default('localhost'),

  /**
   * Reverse-proxy trust boundary (§22, audit 2.3) — decides what Express believes about `req.ip`
   * and `req.protocol`, which the §29 rate limiter and the §31 audit trail both read. Getting this
   * wrong is a security bug in BOTH directions: too permissive lets a client forge `X-Forwarded-For`
   * (spoof their IP, evade the login limiter, poison the audit log); too strict collapses every
   * client into one IP bucket (the proxy's) and records the proxy IP everywhere.
   *
   * Values (passed through `parseTrustProxy`):
   *   - `uniquelocal` (default) — trust `X-Forwarded-For` only when the immediate peer is a private
   *     address (RFC-1918 / fc00::/7). This is the docker-internal Caddy/Traefik in prod, and it is
   *     immune to hop-count drift AND ignores a forged header from a public client. Recommended.
   *   - a number (`1`) — trust exactly N hops from the socket. Use only if the proxy is on a public
   *     IP and the hop count is fixed.
   *   - a comma list of CIDRs — trust exactly those edges (e.g. Cloudflare's ranges if orange-clouded).
   *   - `false` — no proxy; `req.ip` is the raw socket peer (local dev talking to the API directly).
   */
  TRUST_PROXY: z.string().default('uniquelocal'),

  // 32-byte base64 AES-256-GCM master key (replaces AWS KMS on this stack, §32).
  ENCRYPTION_MASTER_KEY: z
    .string()
    .refine((s) => Buffer.from(s, 'base64').length === 32, {
      message: 'ENCRYPTION_MASTER_KEY must decode to exactly 32 bytes (openssl rand -base64 32)',
    }),

  /**
   * Where the API itself reaches object storage. On a single-box deploy this is the container
   * hostname (`http://minio:9000`), which is fast and never leaves the docker network.
   */
  S3_ENDPOINT: z.string().url(),
  /**
   * Where the BROWSER reaches object storage — the host presigned URLs are signed for.
   *
   * ⚠️ These cannot be one value when storage is self-hosted. A presigned URL's signature covers
   * the host, so a URL signed for `http://minio:9000` is not merely awkward for a browser, it is
   * unusable: the name does not resolve outside the docker network, and `http://` would be blocked
   * as mixed content by an HTTPS page anyway. Rewriting the URL afterwards breaks the signature.
   *
   * Defaults to S3_ENDPOINT, so managed storage (R2, S3), local dev and CI — where one host serves
   * both callers — need no new configuration and behave exactly as before.
   */
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((s) => s.toLowerCase() === 'true'),

  // Antivirus scan for uploads (§22.6). Off by default (dev/test); when on, the clamd
  // service must be reachable or uploads fail closed.
  CLAMAV_ENABLED: z
    .string()
    .default('false')
    .transform((s) => s.toLowerCase() === 'true'),
  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),

  SMS_PROVIDER: z.enum(['console', 'telenor', 'jazz']).default('console'),
  SMS_API_KEY: z.string().optional(),
  SMS_SENDER_ID: z.string().optional(),
  SMS_WEBHOOK_HMAC_SECRET: z.string().min(1),
  /** Signs aggregator settlement callbacks (§5.3). OPTIONAL and unset by default: no secret
   *  means no school is integrated, and the webhook fails closed rather than accepting unsigned
   *  callbacks — a stub that ships half-configured must refuse, not trust. */
  AGGREGATOR_WEBHOOK_HMAC_SECRET: z.string().optional(),

  // Outbound email (SA8 lead notifications). ALL optional: with no SMTP_HOST the mailer NO-OPS
  // (logs a warning) so lead capture still works un-configured — set these to actually deliver.
  // For Gmail use host smtp.gmail.com, port 587, and an App Password (never the account password).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.string().default('false').transform((s) => s.toLowerCase() === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** From address on outbound mail; falls back to SMTP_USER when unset. */
  SMTP_FROM: z.string().optional(),
  /** Where new-lead / demo-request notifications are sent (SA8). Defaults to the owner's address. */
  LEAD_NOTIFY_EMAIL: z.string().default('mutaharaslam@gmail.com'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // Error monitoring (§31). Unset ⇒ Sentry stays off (dev/test/CI).
  SENTRY_DSN: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),

  // Redis sliding-window rate limits (§29). On by default; disabled in the test
  // env so the shared-Redis integration suites stay deterministic across many logins.
  //
  // ⚠️ `.default('true')` protects only the case where the key is ABSENT — see the
  // production refusal below, which exists because a copied dev `.env` makes it present.
  RATE_LIMIT_ENABLED: z
    .string()
    .default('true')
    .transform((s) => s.toLowerCase() === 'true'),
}).superRefine((env, ctx) => {
  // ⚠️ **Refuse to start a production server with brute-force protection off.**
  //
  // Found 2026-08-12: the limiter had never fired in local dev, and the reason was simply that
  // `.env` carries `RATE_LIMIT_ENABLED=false`, which `loadDotenv()` puts into `process.env` at the
  // top of `main.ts`. That is correct and wanted locally. What made it a security problem is that
  // `docker-compose.prod.yml` passes `env_file: .env` and its `x-app-env` anchor does not set the
  // variable, so a dev env file copied to a server disables §29 for every school's login page
  // **silently** — the schema default never applies, because the key is present, not missing.
  //
  // Crashing at boot is the point: an operator who genuinely wants it off must say so out loud.
  if (env.NODE_ENV === 'production' && !env.RATE_LIMIT_ENABLED) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['RATE_LIMIT_ENABLED'],
      message:
        'refusing to start: rate limiting is disabled while NODE_ENV=production, which leaves '
        + 'login open to unlimited password guessing (§29). Set RATE_LIMIT_ENABLED=true — a dev '
        + '.env copied to a server is the usual cause.',
    });
  }

  // ⚠️ **Refuse to start production with session cookies that lack the Secure flag (audit 2.2).**
  // COOKIE_SECURE defaults to false for local dev over http; the same failure mode as the limiter
  // above — a dev `.env` copied to a server via `env_file` — would silently ship `access_token` and
  // `refresh_token` without `Secure`, so any downgrade or MITM can read a session. A Secure cookie
  // also cannot be SENT over plain http, so this only holds once TLS terminates at the edge; the
  // crash is the forcing function that makes an operator confirm both are true together.
  if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['COOKIE_SECURE'],
      message:
        'refusing to start: COOKIE_SECURE=false while NODE_ENV=production ships session cookies '
        + 'without the Secure flag (audit 2.2). Set COOKIE_SECURE=true and terminate TLS at the edge '
        + '— a dev .env copied to a server is the usual cause.',
    });
  }

  // ⚠️ **Refuse to start production with the proxy trust boundary disabled (audit 2.3).**
  // Behind Caddy/Traefik, `trust proxy=false` makes `req.ip` the proxy's address for EVERY request:
  // the §29 IP limiter collapses to one shared bucket (5 bad logins lock out a whole school) and the
  // §31 audit trail records the proxy IP instead of the actor. Any non-false value is accepted here;
  // its correctness (hops vs CIDRs) is a deploy decision documented on the field above.
  if (env.NODE_ENV === 'production' && ['false', '0', ''].includes(env.TRUST_PROXY.trim().toLowerCase())) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TRUST_PROXY'],
      message:
        'refusing to start: TRUST_PROXY is disabled while NODE_ENV=production, which collapses every '
        + 'client into one IP-keyed rate-limit bucket and records the proxy IP in the audit trail (§29, '
        + '§31, audit 2.3). Set TRUST_PROXY=uniquelocal (docker-internal proxy) or the trusted hop count.',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

/**
 * Translate `TRUST_PROXY` (a string, so it survives env files and Coolify secrets) into the value
 * Express's `app.set('trust proxy', …)` expects (blueprint §22, audit 2.3):
 *   - 'false'/'true'      → boolean (false = raw socket peer; true = trust all — dev only)
 *   - a pure integer      → number of hops from the socket to trust
 *   - anything else       → passed through as-is: Express `compileTrust` understands the presets
 *                           ('loopback' | 'linklocal' | 'uniquelocal') and a comma-separated CIDR list.
 * Keeping the parse here (not in main.ts) means the API and any other bootstrap share one definition.
 */
export function parseTrustProxy(value: string): boolean | number | string {
  const t = value.trim();
  const lower = t.toLowerCase();
  if (lower === 'false' || lower === '') return false;
  if (lower === 'true') return true;
  if (/^\d+$/.test(t)) return Number(t);
  return t;
}

/** Validate `process.env` and return the typed, coerced config. Throws on failure. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
