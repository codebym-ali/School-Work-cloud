/**
 * Dev seed: provisions a demo tenant so you can log in and exercise the API locally.
 * Idempotent — re-running is a no-op if the `demo` subdomain already exists.
 *
 *   pnpm db:seed
 *   Then: POST http://localhost:3000/api/v1/auth/login  (Host: demo.localhost)
 *         { "email": "owner@demo.pk", "password": "Owner!Secret12" }
 *
 * Uses the platform (BYPASSRLS) connection since it creates a brand-new tenant.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes, randomInt } from 'node:crypto';
import type { Role, StaffType } from '@prisma/client';


// Minimal .env loader (scripts don't get node --env-file automatically).
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
const OWNER_EMAIL = 'owner@demo.pk';
const OWNER_PASSWORD = 'Owner!Secret12';
const PLATFORM_EMAIL = 'admin@platform.pk';
const PLATFORM_PASSWORD = 'Admin!Secret12';


type StaffSpec = { email: string; roles: Role[]; staffType: StaffType; designation: string };

const STAFF: StaffSpec[] = [
  { email: `campus.admin@${SUBDOMAIN}.pk`, roles: ['CAMPUS_ADMIN'], staffType: 'ADMIN', designation: 'Campus Administrator' },
  { email: `teacher@${SUBDOMAIN}.pk`, roles: ['TEACHER'], staffType: 'TEACHER', designation: 'Class Teacher' },
  { email: `accountant@${SUBDOMAIN}.pk`, roles: ['ACCOUNTANT'], staffType: 'ACCOUNTANT', designation: 'Accountant' },
  { email: `hr@${SUBDOMAIN}.pk`, roles: ['HR_MANAGER'], staffType: 'ADMIN', designation: 'HR Manager' },
  { email: `admissions@${SUBDOMAIN}.pk`, roles: ['ADMISSION_CONTROLLER'], staffType: 'ADMIN', designation: 'Admission Controller' },
  { email: `assistant@${SUBDOMAIN}.pk`, roles: ['STAFF'], staffType: 'CLERK', designation: 'Office Assistant' },
];

/**
 * Create any staff account that does not exist yet, and return the generated password if it made
 * one. Idempotent PER USER, deliberately.
 *
 * ⚠️ The seed used to create ONLY an owner, which left the staff door untestable in every
 * environment — laptop, CI and deployed demo alike. It is a hole in the seed, not missing data on
 * one box: the owner is REJECTED by the staff login (`auth/login`), because the owner door has its
 * own endpoint (`auth/owner-login`), so an owner account cannot stand in for staff.
 *
 * ⚠️ Per-USER rather than per-tenant idempotence matters: the seed returns early when the tenant
 * exists, so before this, adding fixtures could never reach an environment that had already been
 * seeded once — the change would be invisible exactly where it was needed.
 *
 * ⚠️ ACCOUNTANT and ADMISSION_CONTROLLER are per-campus SEATS, one each; a second on the same
 * campus is a 409 by design, which is why exactly one of each appears above.
 */
async function ensureStaff(prisma: PrismaClient, schoolId: string, campusId: string): Promise<{ created: StaffSpec[]; password?: string }> {
  const existing = await prisma.user.findMany({
    where: { schoolId, email: { in: STAFF.map((s) => s.email) } },
    select: { email: true },
  });
  const have = new Set(existing.map((u: { email: string }) => u.email));
  const missing = STAFF.filter((s) => !have.has(s.email));
  if (missing.length === 0) return { created: [] };

  // Generated per run and printed once. A literal would be published in the repo — which is how the
  // old `Owner!Secret12` came to need rotation on a public box before it could be shown to anyone.
  const password = `Sw-${randomBytes(9).toString('base64url').replace(/[-_]/g, '')}-${randomInt(1000, 9999)}`;
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const used = await prisma.staffProfile.count({ where: { schoolId } });
  let code = used + 1;
  for (const person of missing) {
    const user = await prisma.user.create({
      data: { schoolId, campusId, email: person.email, roles: person.roles, status: 'ACTIVE', passwordHash },
    });
    // A staff PROFILE as well as a login: the directory, payroll and attendance all key off it, so a
    // user without one is a person the school cannot roster, pay, or mark present.
    await prisma.staffProfile.create({
      data: {
        schoolId,
        userId: user.id,
        staffType: person.staffType,
        employeeCode: `EMP-${String(code++).padStart(3, '0')}`,
        fullName: person.designation,
        designation: person.designation,
        joinedAt: new Date('2026-04-01'),
      },
    });
  }
  return { created: missing, password };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    datasourceUrl: process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  try {
    // Platform (vendor) admin — a cross-tenant operator, seeded independently of the
    // demo tenant so re-running always ensures it exists.
    const platformAdmin = await prisma.platformUser.findUnique({ where: { email: PLATFORM_EMAIL } });
    if (platformAdmin) {
      console.log(`Platform admin "${PLATFORM_EMAIL}" already exists — nothing to do.`);
    } else {
      await prisma.platformUser.create({
        data: {
          email: PLATFORM_EMAIL,
          name: 'Platform Admin',
          role: 'SUPER_ADMIN',
          status: 'ACTIVE',
          passwordHash: await argon2.hash(PLATFORM_PASSWORD, { type: argon2.argon2id }),
        },
      });
      console.log(`✔ Seeded platform admin: ${PLATFORM_EMAIL} / ${PLATFORM_PASSWORD} (vendor console)`);
    }

    const existing = await prisma.school.findFirst({ where: { subdomain: SUBDOMAIN } });
    if (existing) {
      // Top up rather than bail: fixtures added to this file must be able to reach an environment
      // that was seeded before they existed, which is every long-lived one.
      const campus = await prisma.campus.findFirst({ where: { schoolId: existing.id }, select: { id: true } });
      if (!campus) {
        console.log(`Demo tenant "${SUBDOMAIN}" exists but has no campus — nothing to top up.`);
        return;
      }
      const { created, password } = await ensureStaff(prisma, existing.id, campus.id);
      if (created.length === 0) {
        console.log(`Demo tenant "${SUBDOMAIN}" already exists and its staff fixtures are present — nothing to do.`);
        return;
      }
      console.log(`✔ Added ${created.length} staff account(s) to existing tenant "${SUBDOMAIN}"`);
      console.log(`  password (all of them): ${password}`);
      for (const p of created) console.log(`  ${p.email.padEnd(28)} ${p.roles.join(', ')}`);
      return;
    }

    const school = await prisma.school.create({ data: { name: 'Demo School', subdomain: SUBDOMAIN } });
    const campus = await prisma.campus.create({ data: { schoolId: school.id, name: 'Main Campus' } });
    await prisma.user.create({
      data: {
        schoolId: school.id,
        email: OWNER_EMAIL,
        roles: ['OWNER_ADMIN'],
        status: 'ACTIVE',
        passwordHash: await argon2.hash(OWNER_PASSWORD, { type: argon2.argon2id }),
      },
    });
    const year = await prisma.academicYear.create({
      data: {
        schoolId: school.id,
        name: '2026-27',
        startDate: new Date('2026-04-01'),
        endDate: new Date('2027-03-31'),
        isCurrent: true,
      },
    });
    const klass = await prisma.class.create({
      data: { schoolId: school.id, campusId: campus.id, name: 'Grade 1', order: 1 },
    });
    await prisma.section.create({ data: { schoolId: school.id, classId: klass.id, name: 'A' } });

    const seededStaff = await ensureStaff(prisma, school.id, campus.id);

    console.log('✔ Seeded demo tenant');
    console.log(`  host:     ${SUBDOMAIN}.localhost (map to 127.0.0.1, or set Host header)`);
    console.log(`  login:    ${OWNER_EMAIL} / ${OWNER_PASSWORD}`);
    console.log(`  year:     ${year.name} (current), campus "${campus.name}", class "Grade 1" section "A"`);
    console.log(`  staff:    ${seededStaff.created.length} accounts at the STAFF door, password: ${seededStaff.password}`);
    for (const p of seededStaff.created) console.log(`              ${p.email.padEnd(28)} ${p.roles.join(', ')}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
