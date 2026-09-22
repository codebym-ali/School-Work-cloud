/* Read-only: report what lives under each campus of the demo tenant, so a targeted clean-up of the
 * E2E/QA test debris can be planned without guessing the blast radius. Deletes nothing. */
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
  const prisma = new PrismaClient({ datasourceUrl: process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL });
  try {
    const school = await prisma.school.findFirst({ where: { subdomain: 'demo' }, select: { id: true } });
    if (!school) { console.log('no demo school'); return; }
    const campuses = await prisma.campus.findMany({ where: { schoolId: school.id }, select: { id: true, name: true } });
    for (const c of campuses) {
      const classIds = (await prisma.class.findMany({ where: { campusId: c.id }, select: { id: true } })).map((x) => x.id);
      const sectionIds = classIds.length ? (await prisma.section.findMany({ where: { classId: { in: classIds } }, select: { id: true } })).map((x) => x.id) : [];
      const enrolIds = (await prisma.studentEnrollment.findMany({ where: { campusId: c.id }, select: { id: true } })).map((x) => x.id);
      const [classes, sections, subjects, enrols, activeEnrols, invoices, payments, users, examDefs, feeStructures] = await Promise.all([
        classIds.length, sectionIds.length,
        classIds.length ? prisma.subject.count({ where: { classId: { in: classIds } } }) : 0,
        enrolIds.length, prisma.studentEnrollment.count({ where: { campusId: c.id, status: 'ACTIVE' } }),
        enrolIds.length ? prisma.feeInvoice.count({ where: { enrollmentId: { in: enrolIds } } }) : 0,
        enrolIds.length ? prisma.feePayment.count({ where: { invoice: { enrollmentId: { in: enrolIds } } } }) : 0,
        prisma.user.count({ where: { campusId: c.id } }),
        classIds.length ? prisma.examDefinition.count({ where: { classId: { in: classIds } } }) : 0,
        classIds.length ? prisma.feeStructure.count({ where: { classId: { in: classIds } } }) : 0,
      ]);
      // Students that would be orphaned if this campus went away (enrolled here and nowhere else).
      const studentIds = enrolIds.length ? [...new Set((await prisma.studentEnrollment.findMany({ where: { campusId: c.id }, select: { studentId: true } })).map((x) => x.studentId))] : [];
      let onlyHere = 0;
      if (studentIds.length) {
        for (const sid of studentIds) {
          const elsewhere = await prisma.studentEnrollment.count({ where: { studentId: sid, campusId: { not: c.id } } });
          if (elsewhere === 0) onlyHere++;
        }
      }
      console.log(`\n[${c.name}] id=${c.id}`);
      console.log(`  classes=${classes} sections=${sections} subjects=${subjects} examDefs=${examDefs} feeStructures=${feeStructures}`);
      console.log(`  enrolments=${enrols} (active=${activeEnrols}) students=${studentIds.length} (only-here=${onlyHere})`);
      console.log(`  invoices=${invoices} payments=${payments} users(campus-bound)=${users}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
