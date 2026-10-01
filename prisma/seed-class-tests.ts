/**
 * Seed class tests for every section × subject in the demo tenant.
 *
 * Creates ~4 tests per subject per section over the past 3 months, with realistic
 * scores for each enrolled student. Idempotent — skips if class tests already exist.
 *
 *   npx tsx prisma/seed-class-tests.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient, Prisma } from '@prisma/client';

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

function rand(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

const TEST_NAMES = [
  'Chapter Quiz', 'Weekly Test', 'Surprise Test', 'Practice Test',
  'Oral Test', 'Written Test', 'Revision Test', 'Class Activity',
];
const TOTAL_MARKS_OPTIONS = [10, 15, 20, 25, 30, 50];

async function main() {
  const prisma = new PrismaClient({
    datasourceUrl: process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL,
  });

  try {
    const school = await prisma.school.findFirst({ where: { subdomain: 'demo' } });
    if (!school) { console.log('No demo tenant found. Run pnpm db:seed first.'); return; }
    const schoolId = school.id;

    // Check if class tests already exist
    const existing = await prisma.classTest.count({ where: { schoolId } });
    if (existing > 0) {
      console.log(`Demo tenant already has ${existing} class tests — skipping.`);
      return;
    }

    // Fetch sections with their class's subjects
    const sections = await prisma.section.findMany({
      where: { schoolId },
      include: {
        class: { select: { name: true, id: true } },
      },
    });

    // Fetch all subjects grouped by class
    const allSubjects = await prisma.subject.findMany({
      where: { schoolId },
      select: { id: true, name: true, classId: true },
    });
    const subjectsByClass = new Map<string, typeof allSubjects>();
    for (const s of allSubjects) {
      const arr = subjectsByClass.get(s.classId) ?? [];
      arr.push(s);
      subjectsByClass.set(s.classId, arr);
    }

    if (sections.length === 0) { console.log('No sections found.'); return; }

    // Fetch all enrollments grouped by section
    const enrollments = await prisma.studentEnrollment.findMany({
      where: { schoolId, status: 'ACTIVE' },
      select: { id: true, sectionId: true },
    });
    const enrollmentsBySection = new Map<string, string[]>();
    for (const e of enrollments) {
      const arr = enrollmentsBySection.get(e.sectionId) ?? [];
      arr.push(e.id);
      enrollmentsBySection.set(e.sectionId, arr);
    }

    // Find a teacher user to be the creator
    const teacher = await prisma.user.findFirst({
      where: { schoolId, roles: { has: 'TEACHER' } },
      select: { id: true },
    });
    // Fall back to campus admin
    const creator = teacher ?? await prisma.user.findFirst({
      where: { schoolId, roles: { has: 'CAMPUS_ADMIN' } },
      select: { id: true },
    });

    let testCount = 0;
    let scoreCount = 0;
    const now = new Date();

    console.log(`Found ${sections.length} sections, ${enrollments.length} enrollments, ${allSubjects.length} subjects.`);
    for (const section of sections) {
      const sectionEnrollments = enrollmentsBySection.get(section.id) ?? [];
      if (sectionEnrollments.length === 0) continue;

      // Get subjects for this section's class
      const sectionSubjects = subjectsByClass.get(section.class.id) ?? [];
      if (sectionSubjects.length === 0) continue;

      for (const subject of sectionSubjects) {
        // Create 3–5 tests per subject spread over the last ~3 months
        const numTests = rand(3, 5);
        for (let t = 0; t < numTests; t++) {
          const daysAgo = rand(5, 90);
          const testDate = new Date(now);
          testDate.setDate(testDate.getDate() - daysAgo);

          const totalMarks = pick(TOTAL_MARKS_OPTIONS);
          const testName = `${pick(TEST_NAMES)} ${t + 1}`;

          const classTest = await prisma.classTest.create({
            data: {
              schoolId,
              sectionId: section.id,
              subjectId: subject.id,
              name: testName,
              totalMarks: new Prisma.Decimal(totalMarks),
              testDate,
              createdById: creator?.id ?? null,
            },
          });
          testCount++;

          // Create scores for each enrolled student
          const scoreData = sectionEnrollments.map((enrollmentId) => {
            const isAbsent = Math.random() < 0.05; // 5% absence rate
            // Simulate a bell-curve-ish distribution
            let pct: number;
            const r = Math.random();
            if (r < 0.05) pct = rand(10, 30);       // weak
            else if (r < 0.15) pct = rand(30, 50);   // below avg
            else if (r < 0.5) pct = rand(50, 70);    // average
            else if (r < 0.85) pct = rand(70, 85);   // good
            else pct = rand(85, 100);                 // excellent

            const marks = isAbsent ? null : Math.round(totalMarks * pct / 100);

            return {
              schoolId,
              classTestId: classTest.id,
              enrollmentId,
              marksObtained: marks !== null ? new Prisma.Decimal(marks) : null,
              isAbsent,
            };
          });

          await prisma.classTestScore.createMany({ data: scoreData });
          scoreCount += scoreData.length;
        }
      }
      console.log(`  ✔ ${section.class.name} ${section.name}: ${sectionSubjects.length} subjects × tests`);
    }

    console.log(`\n✔ Seeded ${testCount} class tests with ${scoreCount} scores across ${sections.length} sections.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
