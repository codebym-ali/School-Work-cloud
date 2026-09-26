/**
 * BULK dataset for hands-on manual testing. Same tenant + logins as `seed-real-school.ts` (so
 * SEED-CREDENTIALS.md / LOGIN-DETAILS.md stay valid), but at a lifelike scale:
 *
 *   • 8 classes (Grade 1-8) × 2 sections = 16 sections
 *   • 20 students per section = 320 students, each with a guardian, enrolment and this month's invoice
 *   • 8 teachers, each assigned per-subject AND as a homeroom teacher (rich /my-classes + attendance)
 *   • ~15 working days of student + staff attendance
 *   • Term 1 Mid-Term exam per class, marks for every student × 6 subjects, PUBLISHED
 *   • Report cards for every student — overall %, grade from the scale, section rank — all computed
 *
 * DESTRUCTIVE and commit-only: it purges every existing school, then rebuilds `demo`.
 *   npx ts-node scripts/seed-bulk.ts --commit
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import type { Role, StaffType } from '@prisma/client';
import * as argon2 from 'argon2';
import { purgeTenant } from '../libs/database/src/tenant-purge';

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
const HMAC_KEY = process.env.ENCRYPTION_MASTER_KEY;
if (!HMAC_KEY) throw new Error('ENCRYPTION_MASTER_KEY is required (for student CNIC login hashes)');
if (!process.argv.includes('--commit')) {
  console.error('Refusing to run without --commit (this purges every school). Re-run: ts-node scripts/seed-bulk.ts --commit');
  process.exit(1);
}

const SUBDOMAIN = 'demo';
const OWNER_PASSWORD = 'Owner!Secret12';
const STAFF_PASSWORD = 'Staff!Secret12';
const STUDENTS_PER_SECTION = 20;

const hashCnic = (cnic: string) => createHmac('sha256', HMAC_KEY).update(cnic.replace(/\D/g, '')).digest('hex');

const MALE = ['Ahmed', 'Ali', 'Hassan', 'Bilal', 'Usman', 'Hamza', 'Saad', 'Zain', 'Umar', 'Ibrahim', 'Faizan', 'Talha', 'Danish', 'Rehan', 'Shahzaib'];
const FEMALE = ['Ayesha', 'Fatima', 'Zainab', 'Maryam', 'Hira', 'Sana', 'Iqra', 'Areeba', 'Noor', 'Amna', 'Rabia', 'Mahnoor', 'Eman', 'Laiba', 'Aliza'];
const LAST = ['Khan', 'Malik', 'Sheikh', 'Butt', 'Chaudhry', 'Qureshi', 'Ansari', 'Siddiqui', 'Baig', 'Raza', 'Farooq', 'Javed', 'Nawaz', 'Iqbal', 'Aslam'];
const pick = <T>(a: T[], i: number) => a[i % a.length];

interface Cred { role: string; who: string; email?: string; password?: string; note?: string }

function recentWorkingDays(n: number): Date[] {
  const out: Date[] = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  while (out.length < n) {
    if (d.getUTCDay() !== 0) out.unshift(new Date(d));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}
const gradeOf = (p: number) => (p >= 90 ? 'A+' : p >= 80 ? 'A' : p >= 70 ? 'B' : p >= 60 ? 'C' : p >= 50 ? 'D' : 'F');

async function main() {
  const db = new PrismaClient({ datasourceUrl: process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL });
  const ownerHash = await argon2.hash(OWNER_PASSWORD, { type: argon2.argon2id });
  const staffHash = await argon2.hash(STAFF_PASSWORD, { type: argon2.argon2id });
  try {
    for (const s of await db.school.findMany({ select: { id: true, subdomain: true } })) {
      await purgeTenant(db, s.id);
      console.log(`  purged school ${s.subdomain}`);
    }
    const creds = await createAll(db, ownerHash, staffHash);
    writeCreds(creds);
    console.log(`\n✔ Committed. Bulk demo is live at ${SUBDOMAIN}.localhost. Credentials in SEED-CREDENTIALS.md`);
  } finally {
    await db.$disconnect();
  }
}

async function createAll(db: PrismaClient, ownerHash: string, staffHash: string): Promise<Cred[]> {
  const creds: Cred[] = [];
  const school = await db.school.create({ data: { name: 'City Grammar School', subdomain: SUBDOMAIN } });
  const sid = school.id;
  const campus = await db.campus.create({ data: { schoolId: sid, name: 'Main Campus', address: 'Model Town, Lahore' } });
  const year = await db.academicYear.create({ data: { schoolId: sid, name: '2026-27', startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'), isCurrent: true } });
  const term = await db.term.create({ data: { schoolId: sid, academicYearId: year.id, name: 'Term 1', startDate: new Date('2026-04-01'), endDate: new Date('2026-09-30') } });

  await db.gradeScale.createMany({
    data: [
      { label: 'A+', minPercent: 90, maxPercent: 100, gradePoint: 4.0 }, { label: 'A', minPercent: 80, maxPercent: 89.99, gradePoint: 3.7 },
      { label: 'B', minPercent: 70, maxPercent: 79.99, gradePoint: 3.0 }, { label: 'C', minPercent: 60, maxPercent: 69.99, gradePoint: 2.0 },
      { label: 'D', minPercent: 50, maxPercent: 59.99, gradePoint: 1.0 }, { label: 'F', minPercent: 0, maxPercent: 49.99, gradePoint: 0.0 },
    ].map((b) => ({ ...b, schoolId: sid, academicYearId: year.id })),
  });

  const mkUser = (email: string, roles: Role[], hash: string, campusId: string | null) =>
    db.user.create({ data: { schoolId: sid, email, roles, status: 'ACTIVE', passwordHash: hash, passwordChangedAt: new Date(), campusId } });

  const owner = await mkUser('owner@demo.pk', ['OWNER_ADMIN'], ownerHash, null);
  creds.push({ role: 'Owner (OWNER_ADMIN)', who: 'School owner', email: owner.email, password: OWNER_PASSWORD });

  const staffSpecs: { email: string; roles: Role[]; type: StaffType; designation: string; campusBound: boolean; name: string }[] = [
    { email: 'admin@demo.pk', roles: ['CAMPUS_ADMIN'], type: 'ADMIN', designation: 'Campus Administrator', campusBound: true, name: 'Nadia Khan' },
    { email: 'accountant@demo.pk', roles: ['ACCOUNTANT'], type: 'ACCOUNTANT', designation: 'Accountant', campusBound: true, name: 'Imran Malik' },
    { email: 'hr@demo.pk', roles: ['STAFF', 'HR_MANAGER'], type: 'ADMIN', designation: 'HR Manager', campusBound: true, name: 'Sadia Sheikh' },
    { email: 'admissions@demo.pk', roles: ['ADMISSION_CONTROLLER'], type: 'ADMIN', designation: 'Admission Officer', campusBound: true, name: 'Bilal Qureshi' },
    { email: 'ops@demo.pk', roles: ['STAFF', 'OPERATIONS_ADMIN'], type: 'ADMIN', designation: 'Operations Admin', campusBound: false, name: 'Kamran Rashid' },
  ];
  const teacherNames = ['Ayesha Farooq', 'Usman Raza', 'Hira Ansari', 'Saad Baig', 'Maryam Javed', 'Danish Ali', 'Rabia Sheikh', 'Talha Nawaz'];
  teacherNames.forEach((name, i) => staffSpecs.push({ email: `teacher${i + 1}@demo.pk`, roles: ['TEACHER'], type: 'TEACHER', designation: 'Teacher', campusBound: true, name }));

  const teachers: { staffId: string; userId: string }[] = [];
  let empSeq = 1;
  for (const s of staffSpecs) {
    const u = await mkUser(s.email, s.roles, staffHash, s.campusBound ? campus.id : null);
    const staff = await db.staffProfile.create({ data: { schoolId: sid, userId: u.id, staffType: s.type, employeeCode: `EMP-${String(empSeq++).padStart(3, '0')}`, fullName: s.name, designation: s.designation, joinedAt: new Date('2024-04-01') } });
    if (s.type === 'TEACHER') teachers.push({ staffId: staff.id, userId: u.id });
    creds.push({ role: s.roles.join(', '), who: s.name, email: s.email, password: STAFF_PASSWORD });
  }

  // Classes → subjects → sections.
  const SUBJECTS = ['Mathematics', 'English', 'Urdu', 'Islamiyat', 'Science', 'Computer'];
  const CLASSES = Array.from({ length: 8 }, (_, i) => ({ name: `Grade ${i + 1}`, order: i + 1, tuition: 2500 + i * 250 }));
  const feeHead = await db.feeHead.create({ data: { schoolId: sid, name: 'Tuition' } });

  const sections: { id: string; classId: string; className: string; label: string; subjectIds: string[] }[] = [];
  for (const c of CLASSES) {
    const klass = await db.class.create({ data: { schoolId: sid, campusId: campus.id, name: c.name, order: c.order } });
    const subjectIds: string[] = [];
    for (const sub of SUBJECTS) {
      const created = await db.subject.create({ data: { schoolId: sid, classId: klass.id, name: sub, periodsPerWeek: sub === 'Mathematics' || sub === 'English' ? 6 : 4 } });
      subjectIds.push(created.id);
    }
    await db.feeStructure.create({ data: { schoolId: sid, campusId: campus.id, classId: klass.id, feeHeadId: feeHead.id, academicYearId: year.id, amount: c.tuition, frequency: 'MONTHLY', effectiveFrom: new Date('2026-04-01') } });
    for (const secName of ['A', 'B']) {
      const sec = await db.section.create({ data: { schoolId: sid, classId: klass.id, name: secName } });
      sections.push({ id: sec.id, classId: klass.id, className: c.name, label: `${c.name}-${secName}`, subjectIds });
    }
  }

  // Teacher assignments: a homeroom teacher per section + one teacher per subject per section (cycling).
  let ta = 0;
  const assignments: Prisma.TeacherAssignmentCreateManyInput[] = [];
  for (const sec of sections) {
    assignments.push({ schoolId: sid, staffId: teachers[ta++ % teachers.length].staffId, academicYearId: year.id, sectionId: sec.id, subjectId: null });
    for (const subjectId of sec.subjectIds) assignments.push({ schoolId: sid, staffId: teachers[ta++ % teachers.length].staffId, academicYearId: year.id, sectionId: sec.id, subjectId });
  }
  await db.teacherAssignment.createMany({ data: assignments });

  // Students + guardians + enrolments + invoices; collect rows for the bulk inserts.
  const now = new Date();
  const curMonth = now.getUTCMonth() + 1;
  const curYear = now.getUTCFullYear();
  const markDays = recentWorkingDays(15);
  const attendance: Prisma.AttendanceRecordCreateManyInput[] = [];
  const examResults: Prisma.ExamResultCreateManyInput[] = [];
  // section id → [{ enrollmentId, percent }] for ranking.
  const bySection = new Map<string, { enrollmentId: string; percent: number }[]>();
  const examBySection: { sectionId: string; classId: string; examId: string }[] = [];

  let grSeq = 1, regSeq = 1, receiptNo = 1, idx = 0;
  const sampleStudentLogins: Cred[] = [];

  // One published Mid-Term exam per class.
  const examByClass = new Map<string, string>();
  for (const c of CLASSES) {
    const klassId = sections.find((s) => s.className === c.name)!.classId;
    const exam = await db.examDefinition.create({ data: { schoolId: sid, termId: term.id, classId: klassId, name: 'Mid-Term', examType: 'MID_TERM', weightagePercent: 100, examDate: new Date('2026-08-15'), status: 'PUBLISHED', publishedAt: new Date('2026-08-20'), publishedById: owner.id } });
    examByClass.set(klassId, exam.id);
  }

  for (const sec of sections) {
    const examId = examByClass.get(sec.classId)!;
    examBySection.push({ sectionId: sec.id, classId: sec.classId, examId });
    const ranks: { enrollmentId: string; percent: number }[] = [];
    for (let r = 1; r <= STUDENTS_PER_SECTION; r++) {
      const male = idx % 2 === 0;
      const first = male ? pick(MALE, idx) : pick(FEMALE, idx);
      const last = pick(LAST, idx + 3);
      const fullName = `${first} ${last}`;
      const gr = `GR-${String(grSeq++).padStart(4, '0')}`;
      const regNo = `REG-2026-${String(regSeq++).padStart(4, '0')}`;
      const cnic = `35201${String(1000000 + idx).padStart(7, '0')}${male ? '1' : '2'}`;
      const givePortal = idx < 3;
      let studentUserId: string | null = null;
      if (givePortal) studentUserId = (await db.user.create({ data: { schoolId: sid, email: `student${idx + 1}@demo.pk`, roles: ['STUDENT'], status: 'ACTIVE', campusId: campus.id } })).id;

      const student = await db.student.create({ data: {
        schoolId: sid, grNumber: gr, registrationNo: regNo, fullName, gender: male ? 'MALE' : 'FEMALE',
        dateOfBirth: new Date(Date.UTC(2018 - CLASSES.find((c) => c.name === sec.className)!.order, idx % 12, 5)),
        city: 'Lahore', addressLine: `House ${100 + idx}, Model Town`, nationality: 'Pakistani', status: 'ACTIVE', isActive: true, createdById: owner.id,
        ...(givePortal ? { userId: studentUserId, cnicHash: hashCnic(cnic) } : {}),
      } });

      const parent = await db.parentProfile.create({ data: {
        schoolId: sid, fullName: `${pick(MALE, idx + 5)} ${last}`, phone: `+92300${String(1000000 + idx).padStart(7, '0')}`,
        occupation: pick(['Businessman', 'Doctor', 'Engineer', 'Teacher', 'Shopkeeper'], idx),
        ...(idx % 10 !== 0 ? { phoneVerifiedAt: new Date('2026-04-05') } : {}),
      } });
      await db.studentGuardian.create({ data: { schoolId: sid, studentId: student.id, parentId: parent.id, relation: 'FATHER', isPrimary: true } });
      const enrol = await db.studentEnrollment.create({ data: { schoolId: sid, studentId: student.id, academicYearId: year.id, campusId: campus.id, classId: sec.classId, sectionId: sec.id, rollNumber: r, status: 'ACTIVE', startedAt: new Date('2026-04-01') } });

      // Invoice: ~55% paid, 15% partial, 15% pending, 15% overdue.
      const tuition = CLASSES.find((c) => c.name === sec.className)!.tuition;
      const bucket = idx % 20;
      const overdue = bucket < 3, paidFull = bucket >= 3 && bucket < 14, partial = bucket >= 14 && bucket < 17;
      const paidAmount = paidFull ? tuition : partial ? Math.round(tuition / 2) : 0;
      const status = paidFull ? 'PAID' : partial ? 'PARTIAL' : overdue ? 'OVERDUE' : 'PENDING';
      const dueDate = overdue ? new Date(Date.UTC(curYear, curMonth - 2, 10)) : new Date(Date.UTC(curYear, curMonth - 1, 10));
      const invoice = await db.feeInvoice.create({ data: { schoolId: sid, studentId: student.id, enrollmentId: enrol.id, totalAmount: tuition, paidAmount, dueDate, status, month: overdue ? (curMonth === 1 ? 12 : curMonth - 1) : curMonth, year: curYear } });
      await db.feeInvoiceItem.create({ data: { schoolId: sid, invoiceId: invoice.id, type: 'FEE', feeHeadId: feeHead.id, description: `Tuition — ${sec.className}`, amount: tuition } });
      if (paidAmount > 0) await db.feePayment.create({ data: { schoolId: sid, invoiceId: invoice.id, receiptNo: receiptNo++, amountPaid: paidAmount, method: 'CASH', collectedById: owner.id, paidAt: new Date(Date.UTC(curYear, curMonth - 1, 5)) } });

      // Attendance (mostly present).
      for (const d of markDays) {
        const seed = (idx * 7 + d.getUTCDate()) % 20;
        const st = seed === 0 ? 'ABSENT' : seed === 1 ? 'LATE' : seed === 2 ? 'ON_LEAVE' : 'PRESENT';
        attendance.push({ schoolId: sid, enrollmentId: enrol.id, date: d, session: 'MORNING', status: st as Prisma.AttendanceRecordCreateManyInput['status'], markedById: owner.id });
      }

      // Exam marks — one stable ability per student + per-subject variation, all out of 100.
      const ability = 45 + ((idx * 13 + 7) % 50); // 45..94
      let sum = 0;
      sec.subjectIds.forEach((subjectId, sj) => {
        const marks = Math.max(28, Math.min(99, ability + (((idx * 3 + sj * 17) % 13) - 6)));
        sum += marks;
        examResults.push({ schoolId: sid, examId, enrollmentId: enrol.id, subjectId, marksObtained: marks, totalMarks: 100, isAbsent: false, enteredById: owner.id });
      });
      ranks.push({ enrollmentId: enrol.id, percent: Math.round((sum / sec.subjectIds.length) * 100) / 100 });

      if (givePortal) sampleStudentLogins.push({ role: 'Student (portal)', who: fullName, note: `door /login (student) · Registration No ${regNo} · CNIC ${cnic}` });
      idx++;
    }
    bySection.set(sec.id, ranks);
  }

  await db.attendanceRecord.createMany({ data: attendance });
  await db.examResult.createMany({ data: examResults });

  // Report cards: dense rank within each section by overall %.
  const reportCards: Prisma.ReportCardCreateManyInput[] = [];
  for (const [, ranks] of bySection) {
    const ordered = [...ranks].sort((a, b) => b.percent - a.percent);
    let rank = 0, prev = -1;
    ordered.forEach((s, i) => { if (s.percent !== prev) { rank = i + 1; prev = s.percent; } reportCards.push({ schoolId: sid, termId: term.id, enrollmentId: s.enrollmentId, overallPercent: s.percent, gradeLabel: gradeOf(s.percent), sectionRank: rank }); });
  }
  await db.reportCard.createMany({ data: reportCards });

  await db.school.update({ where: { id: sid }, data: { grPrefix: 'GR-', nextGrNumber: grSeq, registrationPrefix: 'REG-2026-', nextRegistrationNo: regSeq, nextReceiptNo: receiptNo } });

  // Staff attendance for the teachers.
  const staffAtt: Prisma.StaffAttendanceCreateManyInput[] = [];
  teachers.forEach((t, ti) => markDays.forEach((d) => {
    const seed = (ti * 5 + d.getUTCDate()) % 15;
    staffAtt.push({ schoolId: sid, staffId: t.staffId, date: d, session: 'MORNING', status: (seed === 0 ? 'ABSENT' : seed === 1 ? 'LATE' : 'PRESENT') as Prisma.StaffAttendanceCreateManyInput['status'], source: 'ADMIN', markedById: owner.id });
  }));
  await db.staffAttendance.createMany({ data: staffAtt });

  console.log(`  built ${sections.length} sections · ${idx} students · ${examResults.length} marks · ${reportCards.length} report cards · ${attendance.length} attendance rows`);
  creds.push(...sampleStudentLogins.slice(0, 3));
  return creds;
}

function writeCreds(creds: Cred[]) {
  const lines = [
    '# Seed credentials — City Grammar School (demo tenant, BULK dataset)', '',
    'Host: **demo.localhost** · owner-web :3005 · staff-web :3006 · student-web :3003', '',
    '| Role | Name | Email / login | Password |', '|------|------|---------------|----------|',
    ...creds.map((c) => `| ${c.role} | ${c.who} | ${c.email ?? c.note ?? ''} | ${c.password ?? '(reg-no + CNIC)'} |`),
    '', '_Students sign in at the student door with Registration No + CNIC (no password). Staff and owner use email + password._',
    '', `_Generated ${new Date().toISOString()} by scripts/seed-bulk.ts_`,
  ];
  writeFileSync(join(process.cwd(), 'SEED-CREDENTIALS.md'), `${lines.join('\n')}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
