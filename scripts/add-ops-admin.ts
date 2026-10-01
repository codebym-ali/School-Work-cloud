/**
 * QA helper: the demo has no OPERATIONS_ADMIN (the owner's deputy), so there was no way to live-test that
 * entity. This adds ops@demo.pk as a school-wide STAFF member WITH the OPERATIONS_ADMIN capability, plus a
 * staff profile (for the greeting name). Idempotent. Password: Staff!Secret12.
 *
 *   ts-node scripts/add-ops-admin.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
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

async function main() {
  const db = new PrismaClient({ datasourceUrl: process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL });
  try {
    const school = await db.school.findFirst({ where: { subdomain: 'demo' }, select: { id: true } });
    if (!school) throw new Error('demo school not found');
    const email = 'ops@demo.pk';
    const existing = await db.user.findFirst({ where: { schoolId: school.id, email }, select: { id: true } });
    if (existing) {
      console.log('ops@demo.pk already exists — nothing to do.');
      return;
    }
    // An Ops Admin is a per-campus seat: bind to the demo's first campus (never school-wide).
    const campus = await db.campus.findFirst({ where: { schoolId: school.id }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!campus) throw new Error('demo school has no campus');
    const passwordHash = await argon2.hash('Staff!Secret12', { type: argon2.argon2id });
    const user = await db.user.create({
      data: { schoolId: school.id, email, roles: ['STAFF', 'OPERATIONS_ADMIN'] as never, status: 'ACTIVE', campusId: campus.id, passwordHash, passwordChangedAt: new Date() },
    });
    await db.staffProfile.create({
      data: { schoolId: school.id, userId: user.id, staffType: 'ADMIN', employeeCode: 'EMP-OPS', fullName: 'Kamran Operations', designation: 'Operations Admin', joinedAt: new Date('2024-04-01') },
    });
    console.log('✔ Created ops@demo.pk / Staff!Secret12 (OPERATIONS_ADMIN, campus-bound).');
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
