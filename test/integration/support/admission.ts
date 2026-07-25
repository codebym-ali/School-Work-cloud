import request from 'supertest';
import * as argon2 from 'argon2';
import type { INestApplication } from '@nestjs/common';
import type { PlatformPrismaService } from '@database';

/**
 * Student creation is ADMISSION_CONTROLLER-only (§8, segregation of duties) — owner/campus
 * admin get 403. Test fixtures that need a student must therefore go through an admission
 * controller. This seeds a school-wide AC (no campus binding → may admit into any campus) and
 * returns its session + a bound `admit()` helper, so specs don't each re-implement it.
 *
 * `admit(dto)` posts to /api/v1/students as the AC — `dto` must carry `campusId` (the picker),
 * `classId`, `sectionId`, and `guardian` (LINK|CREATE); optional `cnic` provisions the login.
 */
export async function admissionController(
  app: INestApplication,
  platform: PlatformPrismaService,
  schoolId: string,
  host: string,
) {
  const email = `ac-${schoolId.slice(0, 8)}@ac.local`;
  const password = 'Admit!Secret12';
  await platform.user.create({
    data: {
      schoolId,
      email,
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
