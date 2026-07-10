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
          status: 'ACTIVE',
          passwordHash: await argon2.hash(PLATFORM_PASSWORD, { type: argon2.argon2id }),
        },
      });
      console.log(`✔ Seeded platform admin: ${PLATFORM_EMAIL} / ${PLATFORM_PASSWORD} (vendor console)`);
    }

    const existing = await prisma.school.findFirst({ where: { subdomain: SUBDOMAIN } });
    if (existing) {
      console.log(`Demo tenant "${SUBDOMAIN}" already exists — nothing to do.`);
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

    console.log('✔ Seeded demo tenant');
    console.log(`  host:     ${SUBDOMAIN}.localhost (map to 127.0.0.1, or set Host header)`);
    console.log(`  login:    ${OWNER_EMAIL} / ${OWNER_PASSWORD}`);
    console.log(`  year:     ${year.name} (current), campus "${campus.name}", class "Grade 1" section "A"`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
