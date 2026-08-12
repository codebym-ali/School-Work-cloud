import { validateEnv } from './env.schema';

/**
 * The production refusal on `RATE_LIMIT_ENABLED` (§29).
 *
 * Why this exists: the limiter had never fired in local dev, and the reason turned out to be
 * mundane — `.env` carries `RATE_LIMIT_ENABLED=false` and `loadDotenv()` applies it. That is
 * correct locally. The security problem is that `docker-compose.prod.yml` hands the API that same
 * file via `env_file`, so a dev `.env` copied to a server leaves every school's login page open to
 * unlimited password guessing, and **nothing says so** — the schema's `.default('true')` protects
 * only the case where the key is missing, not the case where it is present and false.
 */

/** Every var `envSchema` has no default for — the smallest config that validates at all. */
const REQUIRED = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  PLATFORM_DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  APP_APEX_DOMAIN: 'example.test',
  JWT_ACTIVE_KID: 'k1',
  JWT_KEYS: JSON.stringify({ k1: 'k'.repeat(32) }),
  // 32 bytes, base64 — the schema decodes and checks the length.
  ENCRYPTION_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  SMS_WEBHOOK_HMAC_SECRET: 's'.repeat(32),
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'bucket',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
};

function envFor(overrides: Record<string, string>): Record<string, unknown> {
  return { ...REQUIRED, ...overrides };
}

describe('validateEnv — §29 rate limiting', () => {
  it('refuses to start a production server with rate limiting disabled', () => {
    expect(() => validateEnv(envFor({ NODE_ENV: 'production', RATE_LIMIT_ENABLED: 'false' })))
      .toThrow(/refusing to start/i);
  });

  it('names the variable and the fix in the message, not just "invalid config"', () => {
    // An operator reading a crash log at 2am gets the cause and the remedy, or the crash is just
    // an outage with extra steps.
    expect(() => validateEnv(envFor({ NODE_ENV: 'production', RATE_LIMIT_ENABLED: 'false' })))
      .toThrow(/RATE_LIMIT_ENABLED=true/);
  });

  // ── The cases that keep the rule from being "production never starts" ──────
  it('starts in production when rate limiting is on', () => {
    const env = validateEnv(envFor({ NODE_ENV: 'production', RATE_LIMIT_ENABLED: 'true' }));
    expect(env.RATE_LIMIT_ENABLED).toBe(true);
  });

  it('starts in production when the key is absent, because the default is on', () => {
    // This is the path the schema default was always covering; the refusal must not disturb it.
    const env = validateEnv(envFor({ NODE_ENV: 'production' }));
    expect(env.RATE_LIMIT_ENABLED).toBe(true);
  });

  it('still allows the limiter to be off outside production', () => {
    // Local dev and the integration suites depend on this: they make many logins in a row.
    for (const NODE_ENV of ['development', 'test']) {
      const env = validateEnv(envFor({ NODE_ENV, RATE_LIMIT_ENABLED: 'false' }));
      expect(env.RATE_LIMIT_ENABLED).toBe(false);
    }
  });
});
