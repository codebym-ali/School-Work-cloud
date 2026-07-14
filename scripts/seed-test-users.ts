/**
 * Dev helper: add login-capable test users (one per role) to the demo tenant so the
 * role-based UI + campus scoping can be exercised in a browser. Idempotent — skips a
 * user whose email already exists. Uses the platform (BYPASSRLS) connection.
 *
 *   npx ts-node scripts/seed-test-users.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient, type Role } from '@prisma/client';
import * as argon2 from 'argon2';

const envPath = join(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim();
  }
}

const SUBDOMAIN = 'demo';
const STAFF: Array<{ email: string; password: string; roles: Role[]; campusBound: boolean }> = [
  { email: 'campusadmin@demo.pk', password: 'Campus!Secret12', roles: ['CAMPUS_ADMIN'], campusBound: true },
  { email: 'accountant@demo.pk', password: 'Money!Secret12', roles: ['ACCOUNTANT'], campusBound: true },
  { email: 'teacher@demo.pk', password: 'Teach!Secret12', roles: ['TEACHER'], campusBound: true },
];
const PARENT = { email: 'parent@demo.pk', password: 'Parent!Secret12' };

async function main(): Promise<void> {
  const prisma = new PrismaClient({ datasourceUrl: process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL });
  try {
    const school = await prisma.school.findFirst({ where: { subdomain: SUBDOMAIN } });
    if (!school) throw new Error(`Demo tenant "${SUBDOMAIN}" not found — run pnpm db:seed first.`);
    const campus = await prisma.campus.findFirst({ where: { schoolId: school.id }, orderBy: { name: 'asc' } });
    if (!campus) throw new Error('Demo tenant has no campus.');

    const hash = (p: string) => argon2.hash(p, { type: argon2.argon2id });

    for (const u of STAFF) {
      const existing = await prisma.user.findFirst({ where: { schoolId: school.id, email: u.email } });
      if (existing) {
        console.log(`• ${u.email} already exists — skipped`);
        continue;
      }
      await prisma.user.create({
        data: {
          schoolId: school.id,
          campusId: u.campusBound ? campus.id : null,
          email: u.email,
          passwordHash: await hash(u.password),
          roles: u.roles,
          status: 'ACTIVE',
        },
      });
      console.log(`✔ ${u.email} / ${u.password}  [${u.roles.join(',')}${u.campusBound ? ` @ ${campus.name}` : ''}]`);
    }

    // A real, login-capable PARENT linked to an existing student so the parent view works.
    const existingParent = await prisma.user.findFirst({ where: { schoolId: school.id, email: PARENT.email } });
    if (existingParent) {
      console.log(`• ${PARENT.email} already exists — skipped`);
    } else {
      const student = await prisma.student.findFirst({ where: { schoolId: school.id, deletedAt: null }, orderBy: { createdAt: 'asc' } });
      const user = await prisma.user.create({
        data: { schoolId: school.id, email: PARENT.email, passwordHash: await hash(PARENT.password), roles: ['PARENT'], status: 'ACTIVE' },
      });
      const profile = await prisma.parentProfile.create({
        data: { schoolId: school.id, userId: user.id, fullName: 'Test Parent', phone: '03000000001', phoneVerifiedAt: new Date() },
      });
      if (student) {
        await prisma.studentGuardian.create({
          data: { schoolId: school.id, studentId: student.id, parentId: profile.id, relation: 'GUARDIAN', isPrimary: false },
        });
      }
      console.log(`✔ ${PARENT.email} / ${PARENT.password}  [PARENT${student ? ` → guardian of ${student.fullName}` : ''}]`);
    }

    // A login-capable STUDENT linked to a real Student record (Student.userId) so the
    // self-service portal has someone to resolve. Prefer a student with an ACTIVE enrollment.
    const STUDENT_LOGIN = { email: 'student@demo.pk', password: 'Student!Secret12' };
    const existingStudentUser = await prisma.user.findFirst({ where: { schoolId: school.id, email: STUDENT_LOGIN.email } });
    if (existingStudentUser) {
      console.log(`• ${STUDENT_LOGIN.email} already exists — skipped`);
    } else {
      const rec = await prisma.student.findFirst({
        where: { schoolId: school.id, deletedAt: null, userId: null, enrollments: { some: { status: 'ACTIVE' } } },
        orderBy: { createdAt: 'asc' },
      });
      if (!rec) {
        console.log('• no unlinked enrolled student found — skipped STUDENT user');
      } else {
        const user = await prisma.user.create({
          data: { schoolId: school.id, email: STUDENT_LOGIN.email, passwordHash: await hash(STUDENT_LOGIN.password), roles: ['STUDENT'], status: 'ACTIVE' },
        });
        await prisma.student.update({ where: { id: rec.id }, data: { userId: user.id } });
        console.log(`✔ ${STUDENT_LOGIN.email} / ${STUDENT_LOGIN.password}  [STUDENT → ${rec.fullName} (GR ${rec.grNumber})]`);
      }
    }

    console.log('\nDone. Log in at http://demo.localhost:3001');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
