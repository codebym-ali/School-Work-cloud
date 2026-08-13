import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { MATRIX_ROLES, PERMISSION_MATRIX, type MatrixRole } from '../matrix/permission-matrix';
import { destroyTenant } from './support/tenant';
import { loginRequest } from './support/login';

/**
 * Matrix-conformance harness (blueprint §23, playbook P1.14). Seeds one user per role,
 * then drives every row of the permission matrix against the live routes: a non-admitted
 * role must get 403 (the security-critical assertion), and an admitted role must NOT get a
 * role-403 (positive reachability). Any `@Roles` change that diverges from the encoded
 * matrix fails this suite. MERGE-BLOCKING in spirit (wire as the CI matrix job).
 */
describe('Matrix conformance (e2e, §23 / P1.14)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;

  const sub = `mx-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const ownerEmail = 'owner@mx.pk';
  const ownerPassword = 'Owner!Secret12';
  const staffPassword = 'Staff!Secret12';

  const cookies: Record<MatrixRole, string[]> = {} as Record<MatrixRole, string[]>;
  const csrf: Record<MatrixRole, string> = {} as Record<MatrixRole, string>;

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
  const login = async (email: string, password: string) => {
    const res = await loginRequest(server(), host, email, password);
    return res.headers['set-cookie'] as unknown as string[];
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({ name: 'MX School', subdomain: sub, ownerEmail, ownerPassword });
    schoolId = prov.schoolId;
    const campusId = prov.campusId;

    // OWNER_ADMIN comes from provisioning; seed one user for each other role.
    const hash = await argon2.hash(staffPassword, { type: argon2.argon2id });
    const seed = async (role: MatrixRole, campus: string | null) => {
      await platform.user.create({
        data: { schoolId, email: `${role.toLowerCase()}@mx.pk`, roles: [role] as never, status: 'ACTIVE', passwordHash: hash, campusId: campus ?? undefined },
      });
    };
    await seed('CAMPUS_ADMIN', campusId);
    await seed('ADMISSION_CONTROLLER', campusId);
    await seed('ACCOUNTANT', campusId);
    await seed('TEACHER', campusId);
    await seed('PARENT', null);

    cookies.OWNER_ADMIN = await login(ownerEmail, ownerPassword);
    for (const role of MATRIX_ROLES) {
      if (role !== 'OWNER_ADMIN') cookies[role] = await login(`${role.toLowerCase()}@mx.pk`, staffPassword);
      csrf[role] = csrfOf(cookies[role]);
    }
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  const call = (role: MatrixRole, row: (typeof PERMISSION_MATRIX)[number]) => {
    let r = request(server())[row.method](row.path).set('Host', host).set('Cookie', cookies[role]);
    // Any state-changing method needs the CSRF token; POST/PATCH additionally carry a body + idempotency key.
    if (row.method !== 'get') r = r.set('X-CSRF-Token', csrf[role]).set('Idempotency-Key', randomUUID());
    if (row.method === 'post' || row.method === 'patch') r = r.send(row.body ?? {});
    return r;
  };

  for (const row of PERMISSION_MATRIX) {
    describe(row.label, () => {
      for (const role of MATRIX_ROLES) {
        const admitted = row.allow.includes(role);

        if (!admitted) {
          it(`denies ${role} (403)`, async () => {
            expect((await call(role, row)).status).toBe(403);
          });
        } else if (role === 'OWNER_ADMIN' || !row.scopeGated) {
          // Admitted + (owner OR not scope-gated) → must NOT be a role-403.
          it(`admits ${role} (not 403)`, async () => {
            expect((await call(role, row)).status).not.toBe(403);
          });
        }
        // Admitted + scope-gated non-owner: positive reachability can't be asserted cleanly
        // (a campus/ownership check may 403 legitimately); the deny rows above carry the proof.
      }
    });
  }
});
