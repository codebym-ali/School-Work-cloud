/**
 * QA data-fix: the demo seed created the HR_MANAGER (hr@demo.pk) campus-less (seed-real-school.ts had
 * `campusBound: false`), and the staff directory is campus-scoped — so HR logs in and sees ZERO staff
 * ("No campus is assigned to your account"). The owner UI can't repair it (Campus Hub only lists
 * campus-bound users). This binds HR to the school's Main Campus so the role is functional. Idempotent.
 *
 *   ts-node scripts/fix-hr-campus.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

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
    const campus = await db.campus.findFirst({ where: { schoolId: school.id, name: 'Main Campus' }, select: { id: true } });
    if (!campus) throw new Error('Main Campus not found');
    const hr = await db.user.findFirst({ where: { schoolId: school.id, email: 'hr@demo.pk' }, select: { id: true, campusId: true } });
    if (!hr) throw new Error('hr@demo.pk not found');

    if (hr.campusId === campus.id) {
      console.log('HR already bound to Main Campus — nothing to do.');
      return;
    }
    await db.user.update({ where: { id: hr.id }, data: { campusId: campus.id } });
    console.log(`✔ Bound hr@demo.pk to Main Campus (${campus.id}). HR can now see the staff directory.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
