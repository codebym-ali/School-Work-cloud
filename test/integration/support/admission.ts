import request from 'supertest';
import * as argon2 from 'argon2';
import type { INestApplication } from '@nestjs/common';
import type { PlatformPrismaService } from '@database';

/**
 * Student creation is ADMISSION_CONTROLLER-only (§8, segregation of duties) — owner/campus
 * admin get 403. Test fixtures that need a student must therefore go through an admission
 * controller. This seeds one bound to `campusId` and returns its session + a bound `admit()`
 * helper, so specs don't each re-implement it.
 *
 * `campusId` is REQUIRED: an admission officer is a per-campus seat (exactly one per campus,
 * campus compulsory). A campus-less AC used to mean "school-wide, may admit anywhere" — that
 * was the silent hole, and it now fails closed, so a spec needing students in two campuses
 * seeds two controllers (legal: different campuses).
 *
 * `admit(dto)` posts to /api/v1/students as the AC — `dto` must carry `campusId` (matching
 * this controller's), `classId`, `sectionId`, and `guardian` (LINK|CREATE); optional `cnic`
 * provisions the login.
 */
export async function admissionController(
  app: INestApplication,
  platform: PlatformPrismaService,
  schoolId: string,
  host: string,
  campusId: string,
) {
  const email = `ac-${campusId.slice(0, 8)}@ac.local`;
  const password = 'Admit!Secret12';
  await platform.user.create({
    data: {
      schoolId,
      email,
      campusId,
      roles: ['ADMISSION_CONTROLLER'] as never,
      status: 'ACTIVE',
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
    },
  });
  const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Host', host).send({ email, password });
  const cookies = login.headers['set-cookie'] as unknown as string[];
  const csrf = (cookies.find((c) => c.startsWith('csrf=')) ?? '').split(';')[0].slice(5);

  const admit = (dto: object) =>
    request(app.getHttpServer())
      .post('/api/v1/students')
      .set('Host', host)
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrf)
      .send(dto);

  return { cookies, csrf, admit };
}
