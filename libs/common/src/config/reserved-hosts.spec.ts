import { envSchema } from './env.schema';

/**
 * The platform serves some hosts on its own behalf (`superadmin.<apex>`, and since object storage
 * moved to its own host, `s3.<apex>`). Two independent lists decide what happens to such a label:
 *
 *  - RESERVED_SUBDOMAINS (this file)      — labels that must never resolve to a school
 *  - PLATFORM_HOSTS (the TLS gate)        — labels we serve, and mint certificates for
 *
 * ⚠️ They are deliberately NOT the same set — RESERVED also holds the role labels, which are only
 * valid two-deep, and minting certificates for those would be wrong. But every label in the second
 * list MUST appear in the first, or a school could register it and take over a host the platform
 * depends on. `s3` is the sharp case: every presigned upload URL points there.
 *
 * This lives in libs/common rather than beside the gate because the backend project cannot import
 * the API's controllers; the label list is duplicated here on purpose and pinned by this test.
 */
const PLATFORM_HOSTS_SERVED = ['superadmin', 'admin', 'www', 's3'];

const parseReserved = (value?: string): string[] => {
  const base = {
    APP_APEX_DOMAIN: 'example.com',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/d?schema=public',
    PLATFORM_DATABASE_URL: 'postgresql://u:p@localhost:5432/d?schema=public',
    MIGRATION_DATABASE_URL: 'postgresql://u:p@localhost:5432/d?schema=public',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACTIVE_KID: 'k1',
    JWT_KEYS: '{"k1":"0123456789012345678901234567890123"}',
    ENCRYPTION_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    S3_ENDPOINT: 'http://localhost:9000',
    S3_BUCKET: 'b',
    S3_ACCESS_KEY_ID: 'k',
    S3_SECRET_ACCESS_KEY: 's',
    SMS_WEBHOOK_HMAC_SECRET: 'x',
    ...(value === undefined ? {} : { RESERVED_SUBDOMAINS: value }),
  };
  return envSchema.parse(base).RESERVED_SUBDOMAINS;
};

describe('reserved subdomains vs platform hosts', () => {
  it('reserves the storage label by default, so no school can claim it', () => {
    // Without this, a school registering `s3` takes over the host every presigned upload URL
    // points at — and the failure would look like broken uploads, not a naming collision.
    expect(parseReserved()).toContain('s3');
  });

  it('keeps every platform-served label unclaimable under the shipped deployment config', () => {
    // The value deploy/bootstrap-test-env.sh writes, and what the deploy README prescribes.
    const deployed = parseReserved('www,api,admin,app,s3,superadmin,owner,staff,student');
    for (const label of PLATFORM_HOSTS_SERVED) {
      expect(deployed).toContain(label);
    }
  });
});
