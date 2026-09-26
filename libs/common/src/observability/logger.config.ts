import { ClsServiceManager } from 'nestjs-cls';
import type { Params } from 'nestjs-pino';
import { CLS_KEYS, type RequestUser } from '../context/tenant-context';
import type { Env } from '../config/env.schema';

/**
 * Sensitive body KEY NAMES — credentials and PII that must never land in logs (§31, audit 3.3).
 *
 * Kept as a key list (not hand-written full paths) so the coverage does not drift as the schema
 * grows: each key is redacted at the body root AND one level deep, which is where nested create
 * payloads put it (e.g. admissions sends `guardian: { cnic, phone }`, so `req.body.guardian.cnic`
 * must be caught, not just `req.body.cnic`). Adding a field here updates every position at once.
 */
const SENSITIVE_BODY_KEYS = [
  // credentials
  'password', 'currentPassword', 'newPassword', 'ownerPassword',
  'code', 'otp', 'totp', 'mfaSecret', 'recoveryCode', 'token',
  // government / identity
  'cnic', 'bForm', 'bform',
  // contact
  'phone', 'guardianPhone', 'secondaryPhone', 'alternatePhone',
  // financial
  'bankAccount', 'accountNumber', 'iban',
] as const;

/** Redact each sensitive key at the body root and one nesting level (fast-redact intermediate `*`). */
const SENSITIVE_BODY_PATHS = SENSITIVE_BODY_KEYS.flatMap((k) => [`req.body.${k}`, `req.body.*.${k}`]);

/**
 * Structured JSON logging (blueprint §31). Every line carries the CLS `requestId` plus
 * `schoolId`/`userId` when present, so logs correlate with the §25.1 error envelope and
 * are tenant-attributable. Sensitive fields (auth header, cookies, CSRF token, and the
 * credential/PII body keys in SENSITIVE_BODY_KEYS) are redacted so PII never lands in logs.
 */
export function pinoConfig(env: Env): Params {
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      // Reuse the CLS request id (also used in the error envelope) as the log reqId.
      genReqId: () => ClsServiceManager.getClsService().getId(),
      customProps: () => {
        const cls = ClsServiceManager.getClsService();
        const user = cls.get(CLS_KEYS.user) as RequestUser | undefined;
        return {
          requestId: cls.getId(),
          schoolId: cls.get(CLS_KEYS.schoolId) ?? undefined,
          userId: user?.userId,
        };
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-csrf-token"]',
          'res.headers["set-cookie"]',
          ...SENSITIVE_BODY_PATHS,
        ],
        censor: '[redacted]',
      },
      // Quieter access logs for the health/metrics scrape noise.
      autoLogging: {
        ignore: (req) => {
          const url = (req as { url?: string }).url ?? '';
          return url.includes('/health/') || url.endsWith('/metrics');
        },
      },
    },
  };
}
