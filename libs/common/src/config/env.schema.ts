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

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // Error monitoring (§31). Unset ⇒ Sentry stays off (dev/test/CI).
  SENTRY_DSN: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),

  // Redis sliding-window rate limits (§29). On by default; disabled in the test
  // env so the shared-Redis integration suites stay deterministic across many logins.
  RATE_LIMIT_ENABLED: z
    .string()
    .default('true')
    .transform((s) => s.toLowerCase() === 'true'),
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
