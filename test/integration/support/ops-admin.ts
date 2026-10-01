import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as argon2 from 'argon2';
import type { PlatformPrismaService } from '@database';
import { loginAs } from './login';

/**
 * A school-wide marker for staff attendance (Owner UX 1c).
 *
 * The owner no longer marks staff attendance — the office does (campus admin, or the owner's deputy, the
 * Ops Admin). Suites that need to put rows on the staff register sign in as an Ops Admin. The Ops Admin is a
 * per-campus seat (2026-09-30): bound to `campusId` (default: the school's first campus) and confined to it,
 * and it satisfies CAMPUS_ADMIN through the role hierarchy.
 */
export async function opsAdminSession(
  app: INestApplication,
  platform: PlatformPrismaService,
  schoolId: string,
  host: string,
  email = `ops-${schoolId.slice(0, 8)}@ops.pk`,
  campusId?: string,
) {
  const password = 'Ops!Secret12345';
  const campus = campusId ?? (await platform.campus.findFirstOrThrow({ where: { schoolId }, orderBy: { createdAt: 'asc' }, select: { id: true } })).id;
  await platform.user.create({
    data: {
      schoolId, email, roles: ['STAFF', 'OPERATIONS_ADMIN'] as never, status: 'ACTIVE', campusId: campus,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
    },
  });
  const cookies = await loginAs(app.getHttpServer(), host, email, password, 'staff');
  const csrf = (cookies.find((c) => c.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  /** POST as the Ops Admin — for `/staff-attendance/bulk` and anything else the office does. */
  const post = (path: string, body: object) =>
    request(app.getHttpServer()).post(path).set('Host', host).set('Cookie', cookies).set('X-CSRF-Token', csrf).send(body);
  return { cookies, csrf, post };
}
