/**
 * Dev seed: provisions a demo tenant so you can log in and exercise the API locally.
 * Idempotent — re-running tops up missing fixtures without touching existing ones.
 *
 *   pnpm db:seed
 *
 * Logins created:
 *   Owner:   owner@demo.pk / Owner!Secret12       → http://parent.localhost:3005
 *   Parent:  parent@demo.pk / Parent!Secret12      → http://parent.localhost:3003
 *   Staff:   see console output after run
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
const PARENT_EMAIL = 'parent@demo.pk';
const PARENT_PASSWORD = 'Parent!Secret12';

type StaffSpec = { email: string; roles: Role[]; staffType: StaffType; designation: string };

const STAFF: StaffSpec[] = [
  { email: `campus.admin@${SUBDOMAIN}.pk`, roles: ['CAMPUS_ADMIN'], staffType: 'ADMIN', designation: 'Campus Administrator' },
  { email: `teacher@${SUBDOMAIN}.pk`, roles: ['TEACHER'], staffType: 'TEACHER', designation: 'Class Teacher' },
  { email: `accountant@${SUBDOMAIN}.pk`, roles: ['ACCOUNTANT'], staffType: 'ACCOUNTANT', designation: 'Accountant' },
  { email: `hr@${SUBDOMAIN}.pk`, roles: ['HR_MANAGER'], staffType: 'ADMIN', designation: 'HR Manager' },
  { email: `admissions@${SUBDOMAIN}.pk`, roles: ['ADMISSION_CONTROLLER'], staffType: 'ADMIN', designation: 'Admission Controller' },
  { email: `assistant@${SUBDOMAIN}.pk`, roles: ['STAFF'], staffType: 'CLERK', designation: 'Office Assistant' },
];

const SEAT_ROLES: Role[] = ['CAMPUS_ADMIN', 'ADMISSION_CONTROLLER', 'ACCOUNTANT'];

async function ensureStaff(
  prisma: PrismaClient,
  schoolId: string,
  campuses: Array<{ id: string; name: string }>,
): Promise<{ created: StaffSpec[]; password?: string }> {
  const existing = await prisma.user.findMany({
    where: { schoolId, email: { in: STAFF.map((s) => s.email) } },
    select: { email: true },
  });
  const have = new Set(existing.map((u: { email: string }) => u.email));
  const missing = STAFF.filter((s) => !have.has(s.email));
  if (missing.length === 0) return { created: [] };

  const password = `Sw-${randomBytes(9).toString('base64url').replace(/[-_]/g, '')}-${randomInt(1000, 9999)}`;
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const used = await prisma.staffProfile.count({ where: { schoolId } });
  let code = used + 1;
  const created: StaffSpec[] = [];

  for (const person of missing) {
    const seatRole = person.roles.find((r) => SEAT_ROLES.includes(r));
    let campusId: string | null = null;

    if (seatRole) {
      let found = false;
      for (const c of campuses) {
        const holder = await prisma.user.findFirst({
          where: { schoolId, campusId: c.id, deletedAt: null, roles: { has: seatRole } },
        });
        if (!holder) {
          campusId = c.id;
          found = true;
          break;
        }
      }
      if (!found) {
        console.log(`• ${person.email} skipped — every campus already has a ${seatRole}`);
        continue;
      }
    } else {
      campusId = campuses[0].id;
    }

    const user = await prisma.user.create({
      data: { schoolId, campusId, email: person.email, roles: person.roles, status: 'ACTIVE', passwordHash },
    });
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
    created.push(person);
  }
  return { created, password: created.length > 0 ? password : undefined };
}

const SIBLING_GR = 'GR-0002';
const SIBLING_NAME = 'Fatima Butt';

async function ensureParent(prisma: PrismaClient, schoolId: string): Promise<void> {
  const existing = await prisma.user.findFirst({ where: { schoolId, email: PARENT_EMAIL } });
  if (existing) {
    console.log(`• ${PARENT_EMAIL} already exists`);
    // Still ensure the sibling exists even if the parent was created in a previous run.
    const profile = await prisma.parentProfile.findFirst({ where: { schoolId, userId: existing.id } });
    if (profile) await ensureSibling(prisma, schoolId, profile.id);
    return;
  }

  const passwordHash = await argon2.hash(PARENT_PASSWORD, { type: argon2.argon2id });
  const user = await prisma.user.create({
    data: { schoolId, email: PARENT_EMAIL, passwordHash, roles: ['PARENT'], status: 'ACTIVE' },
  });
  const profile = await prisma.parentProfile.create({
    data: { schoolId, userId: user.id, fullName: 'Test Parent', phone: '03000000001', phoneVerifiedAt: new Date() },
  });
  const student = await prisma.student.findFirst({ where: { schoolId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
  if (student) {
    await prisma.studentGuardian.create({
      data: { schoolId, studentId: student.id, parentId: profile.id, relation: 'GUARDIAN', isPrimary: true },
    });
  }
  console.log(`✔ ${PARENT_EMAIL} / ${PARENT_PASSWORD}  [PARENT${student ? ` → guardian of ${student.fullName}` : ''}]`);

  await ensureSibling(prisma, schoolId, profile.id);
}

async function ensureSibling(prisma: PrismaClient, schoolId: string, parentProfileId: string): Promise<void> {
  const existingSibling = await prisma.student.findFirst({ where: { schoolId, grNumber: SIBLING_GR, deletedAt: null } });
  if (existingSibling) {
    // Ensure guardian link exists
    const link = await prisma.studentGuardian.findFirst({ where: { schoolId, studentId: existingSibling.id, parentId: parentProfileId } });
    if (!link) {
      await prisma.studentGuardian.create({
        data: { schoolId, studentId: existingSibling.id, parentId: parentProfileId, relation: 'GUARDIAN', isPrimary: false },
      });
      console.log(`  ✔ linked ${SIBLING_NAME} to parent`);
    } else {
      console.log(`  • ${SIBLING_NAME} (${SIBLING_GR}) already exists and linked — skipped`);
    }
    return;
  }

  // Find the campus, academic year, and a class/section for the sibling
  const campus = await prisma.campus.findFirst({ where: { schoolId }, orderBy: { name: 'asc' } });
  const year = await prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } });
  if (!campus || !year) {
    console.log(`  • skipped sibling — no campus or academic year`);
    return;
  }

  // Create a separate class for variety (Grade 3) or reuse an existing one
  let klass = await prisma.class.findFirst({ where: { schoolId, name: 'Grade 3' } });
  if (!klass) {
    klass = await prisma.class.create({
      data: { schoolId, campusId: campus.id, name: 'Grade 3', order: 3 },
    });
  }
  let section = await prisma.section.findFirst({ where: { schoolId, classId: klass.id, name: 'A' } });
  if (!section) {
    section = await prisma.section.create({
      data: { schoolId, classId: klass.id, name: 'A' },
    });
  }

  // Create the sibling student
  const sibling = await prisma.student.create({
    data: {
      schoolId,
      grNumber: SIBLING_GR,
      fullName: SIBLING_NAME,
      gender: 'FEMALE',
      dateOfBirth: new Date('2018-09-15'),
      status: 'ACTIVE',
      isActive: true,
    },
  });

  // Enroll in Grade 3 — A
  await prisma.studentEnrollment.create({
    data: {
      schoolId,
      studentId: sibling.id,
      academicYearId: year.id,
      campusId: campus.id,
      classId: klass.id,
      sectionId: section.id,
      rollNumber: 1,
      status: 'ACTIVE',
    },
  });

  // Link to the same parent
  await prisma.studentGuardian.create({
    data: { schoolId, studentId: sibling.id, parentId: parentProfileId, relation: 'GUARDIAN', isPrimary: false },
  });

  console.log(`  ✔ ${SIBLING_NAME} (${SIBLING_GR}) → Grade 3 — A, linked to parent`);
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    datasourceUrl: process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  try {
    // Platform (vendor) admin
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
      const campuses = await prisma.campus.findMany({ where: { schoolId: existing.id }, orderBy: { name: 'asc' } });
      if (!campuses.length) {
        console.log(`Demo tenant "${SUBDOMAIN}" exists but has no campus — nothing to top up.`);
        return;
      }
      const { created, password } = await ensureStaff(prisma, existing.id, campuses);
      if (created.length > 0) {
        console.log(`✔ Added ${created.length} staff account(s) to existing tenant "${SUBDOMAIN}"`);
        console.log(`  password (all of them): ${password}`);
        for (const p of created) console.log(`  ${p.email.padEnd(28)} ${p.roles.join(', ')}`);
      } else {
        console.log(`Demo tenant "${SUBDOMAIN}" staff fixtures are present.`);
      }
      await ensureParent(prisma, existing.id);
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

    const seededStaff = await ensureStaff(prisma, school.id, [campus]);
    await ensureParent(prisma, school.id);

    console.log('\n✔ Seeded demo tenant');
    console.log(`  host:     ${SUBDOMAIN}.localhost (map to 127.0.0.1, or set Host header)`);
    console.log(`  owner:    ${OWNER_EMAIL} / ${OWNER_PASSWORD}`);
    console.log(`  parent:   ${PARENT_EMAIL} / ${PARENT_PASSWORD}`);
    console.log(`  year:     ${year.name} (current), campus "${campus.name}", class "Grade 1" section "A"`);
    if (seededStaff.created.length > 0) {
      console.log(`  staff:    ${seededStaff.created.length} accounts, password: ${seededStaff.password}`);
      for (const p of seededStaff.created) console.log(`              ${p.email.padEnd(28)} ${p.roles.join(', ')}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
