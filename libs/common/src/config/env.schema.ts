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
    .default('www,api,admin,app')
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

  // 32-byte base64 AES-256-GCM master key (replaces AWS KMS on this stack, §32).
  ENCRYPTION_MASTER_KEY: z
    .string()
    .refine((s) => Buffer.from(s, 'base64').length === 32, {
      message: 'ENCRYPTION_MASTER_KEY must decode to exactly 32 bytes (openssl rand -base64 32)',
    }),

  S3_ENDPOINT: z.string().url(),
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
});

export type Env = z.infer<typeof envSchema>;

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
