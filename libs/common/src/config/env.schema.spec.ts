import { parseTrustProxy, validateEnv } from './env.schema';

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
    // A valid prod config must also satisfy the COOKIE_SECURE / TRUST_PROXY guards; TRUST_PROXY
    // defaults to a safe value, so only COOKIE_SECURE needs setting to isolate the limiter check.
    const env = validateEnv(envFor({ NODE_ENV: 'production', RATE_LIMIT_ENABLED: 'true', COOKIE_SECURE: 'true' }));
    expect(env.RATE_LIMIT_ENABLED).toBe(true);
  });

  it('starts in production when the key is absent, because the default is on', () => {
    // This is the path the schema default was always covering; the refusal must not disturb it.
    const env = validateEnv(envFor({ NODE_ENV: 'production', COOKIE_SECURE: 'true' }));
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

describe('validateEnv — audit 2.2 Secure cookies in production', () => {
  it('refuses to start a production server with COOKIE_SECURE=false', () => {
    expect(() => validateEnv(envFor({ NODE_ENV: 'production', COOKIE_SECURE: 'false' })))
      .toThrow(/refusing to start/i);
    expect(() => validateEnv(envFor({ NODE_ENV: 'production', COOKIE_SECURE: 'false' })))
      .toThrow(/COOKIE_SECURE=true/);
  });

  it('refuses when COOKIE_SECURE is absent in production (default is false)', () => {
    // The dangerous path: the key is simply not set on the server and the default applies.
    expect(() => validateEnv(envFor({ NODE_ENV: 'production' }))).toThrow(/COOKIE_SECURE/);
  });

  it('starts in production when COOKIE_SECURE=true', () => {
    const env = validateEnv(envFor({ NODE_ENV: 'production', COOKIE_SECURE: 'true', TRUST_PROXY: '1' }));
    expect(env.COOKIE_SECURE).toBe(true);
  });

  it('leaves COOKIE_SECURE=false alone outside production (local dev over http)', () => {
    const env = validateEnv(envFor({ NODE_ENV: 'development', COOKIE_SECURE: 'false' }));
    expect(env.COOKIE_SECURE).toBe(false);
  });
});

describe('validateEnv — audit 2.3 proxy trust boundary in production', () => {
  const prodOk = { NODE_ENV: 'production', COOKIE_SECURE: 'true' };

  it('refuses to start production with TRUST_PROXY disabled', () => {
    for (const TRUST_PROXY of ['false', '0', '']) {
      expect(() => validateEnv(envFor({ ...prodOk, TRUST_PROXY })))
        .toThrow(/refusing to start/i);
    }
  });

  it('defaults to uniquelocal, so production starts when the key is absent', () => {
    const env = validateEnv(envFor(prodOk));
    expect(env.TRUST_PROXY).toBe('uniquelocal');
  });

  it('accepts a hop count or a CIDR list in production', () => {
    expect(validateEnv(envFor({ ...prodOk, TRUST_PROXY: '1' })).TRUST_PROXY).toBe('1');
    expect(validateEnv(envFor({ ...prodOk, TRUST_PROXY: '173.245.48.0/20,103.21.244.0/22' })).TRUST_PROXY)
      .toContain('173.245.48.0/20');
  });
});

describe('parseTrustProxy', () => {
  it('maps booleans', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy(' TRUE ')).toBe(true);
  });
  it('maps a pure integer to a hop count (number)', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
  });
  it('passes presets and CIDR lists through as strings', () => {
    expect(parseTrustProxy('uniquelocal')).toBe('uniquelocal');
    expect(parseTrustProxy('loopback')).toBe('loopback');
    expect(parseTrustProxy('10.0.0.0/8,172.16.0.0/12')).toBe('10.0.0.0/8,172.16.0.0/12');
  });
});
