import { ClsServiceManager } from 'nestjs-cls';
import type { Params } from 'nestjs-pino';
import { CLS_KEYS, type RequestUser } from '../context/tenant-context';
import type { Env } from '../config/env.schema';

/**
 * Structured JSON logging (blueprint §31). Every line carries the CLS `requestId` plus
 * `schoolId`/`userId` when present, so logs correlate with the §25.1 error envelope and
 * are tenant-attributable. Sensitive fields (auth header, cookies, password/CNIC/phone/
 * bank account in bodies) are redacted so PII never lands in logs.
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
          'res.headers["set-cookie"]',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
          'req.body.ownerPassword',
          'req.body.cnic',
          'req.body.phone',
          'req.body.guardianPhone',
          'req.body.bankAccount',
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
