/**
 * Rebuild the database with ONE realistic school for hands-on testing.
 *
 * Replaces the accumulated dummy/E2E/QA data with a believable Falcon School System: an owner,
 * TWO campuses (Main Campus + Girls Campus), the full staff bench, classes/sections/subjects,
 * students with guardians and enrolments, fees + invoices + payments, attendance, exams + marks +
 * report cards, leave records, salary structures + payroll + payslips — enough to exercise every
 * screen with lifelike numbers and a working campus-lens dropdown.
 *
 * All login credentials are written to SEED-CREDENTIALS.md (gitignored) so future testing is a
 * copy-paste away.
 *
 *   npx ts-node scripts/seed-real-school.ts            # DRY RUN: build it all in a rolled-back
 *                                                      #   transaction to validate; writes creds file.
 *   npx ts-node scripts/seed-real-school.ts --commit   # DESTRUCTIVE: purge every existing school,
 *                                                      #   then create the school under `demo`.
 *
 * Safety: dry run writes nothing to the DB (one transaction, rolled back) and uses a throwaway
 * subdomain so it cannot collide with the live `demo`. --commit is the only mode that deletes.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { Role, StaffType } from '@prisma/client';
import * as argon2 from 'argon2';
import { purgeTenant } from '../libs/database/src/tenant-purge';

// ── env ──────────────────────────────────────────────────────────────────────
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

const COMMIT = process.argv.includes('--commit');
const SUBDOMAIN = COMMIT ? 'demo' : `seed-dryrun-${Date.now()}`;

// ── passwords (documented in SEED-CREDENTIALS.md) ──────────────────────────────
const OWNER_PASSWORD = 'Owner!Secret12';
const STAFF_PASSWORD = 'Staff!Secret12';

const hashCnic = (cnic: string) => createHmac('sha256', HMAC_KEY).update(cnic.replace(/\D/g, '')).digest('hex');

// ── believable Pakistani names ─────────────────────────────────────────────────
const MALE = ['Ahmed', 'Ali', 'Hassan', 'Bilal', 'Usman', 'Hamza', 'Saad', 'Zain', 'Umar', 'Ibrahim', 'Faizan', 'Talha', 'Danish', 'Rehan', 'Shahzaib'];
const FEMALE = ['Ayesha', 'Fatima', 'Zainab', 'Maryam', 'Hira', 'Sana', 'Iqra', 'Areeba', 'Noor', 'Amna', 'Rabia', 'Mahnoor', 'Eman', 'Laiba', 'Aliza'];
const LAST = ['Khan', 'Malik', 'Sheikh', 'Butt', 'Chaudhry', 'Qureshi', 'Ansari', 'Siddiqui', 'Baig', 'Raza', 'Farooq', 'Javed', 'Nawaz', 'Iqbal', 'Aslam'];
const pick = <T>(a: T[], i: number) => a[i % a.length];

const SUBJECTS = ['Mathematics', 'English', 'Urdu', 'Islamiyat', 'Science', 'Computer'];
const CLASSES = [
  { name: 'Grade 6', order: 6, tuition: 3500 },
  { name: 'Grade 7', order: 7, tuition: 4000 },
  { name: 'Grade 8', order: 8, tuition: 4500 },
];

function gradeOf(pct: number): string {
  if (pct >= 90) return 'A+';
  if (pct >= 80) return 'A';
  if (pct >= 70) return 'B';
  if (pct >= 60) return 'C';
  if (pct >= 50) return 'D';
  return 'F';
}

interface Cred { role: string; who: string; email?: string; password?: string; note?: string }
interface Counters { empSeq: number; grSeq: number; regSeq: number; receiptNo: number; studentUserSeq: number }

async function main() {
  const db = new PrismaClient({ datasourceUrl: process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL });
  const ownerHash = await argon2.hash(OWNER_PASSWORD, { type: argon2.argon2id });
  const staffHash = await argon2.hash(STAFF_PASSWORD, { type: argon2.argon2id });

  try {
    if (COMMIT) {
      const schools = await db.school.findMany({ select: { id: true, subdomain: true } });
      for (const s of schools) {
        await purgeTenant(db, s.id);
        // eslint-disable-next-line no-console
        console.log(`  purged school ${s.subdomain}`);
      }
      const creds = await createAll(db, ownerHash, staffHash);
      writeCreds(creds);
      // eslint-disable-next-line no-console
      console.log(`\n✔ Committed. Falcon School System is live at ${SUBDOMAIN}.localhost. Credentials in SEED-CREDENTIALS.md`);
      return;
    }

    // DRY RUN: build everything in a transaction, then roll back.
    let creds: Cred[] = [];
    await db.$transaction(async (tx) => {
      creds = await createAll(tx as unknown as PrismaClient, ownerHash, staffHash);
      throw new ROLLBACK();
    }, { timeout: 120_000 }).catch((e) => { if (!(e instanceof ROLLBACK)) throw e; });
    writeCreds(creds);
    // eslint-disable-next-line no-console
    console.log('\n(dry run — nothing written; all inserts validated in a rolled-back transaction.');
    console.log(' SEED-CREDENTIALS.md written. Re-run with --commit to purge existing data and apply.)');
  } finally {
    await db.$disconnect();
  }
}

class ROLLBACK extends Error {}

// ── shared types ──────────────────────────────────────────────────────────────
interface StaffSpec { email: string; roles: Role[]; type: StaffType; designation: string; campusBound: boolean; name: string }
interface SectionInfo { id: string; classId: string; className: string; label: string; subjectIds: string[] }
interface StaffInfo { staffId: string; userId: string; spec: StaffSpec }

async function createAll(db: PrismaClient, ownerHash: string, staffHash: string): Promise<Cred[]> {
  const creds: Cred[] = [];
  const counters: Counters = { empSeq: 1, grSeq: 1, regSeq: 1, receiptNo: 1, studentUserSeq: 1 };

  const school = await db.school.create({ data: { name: 'Falcon School System', subdomain: SUBDOMAIN } });
  const sid = school.id;
  const mainCampus = await db.campus.create({ data: { schoolId: sid, name: 'Main Campus', address: 'Model Town, Lahore' } });
  const year = await db.academicYear.create({
    data: { schoolId: sid, name: '2026-27', startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'), isCurrent: true },
  });
  const term = await db.term.create({ data: { schoolId: sid, academicYearId: year.id, name: 'Term 1', startDate: new Date('2026-04-01'), endDate: new Date('2026-09-30') } });

  await db.gradeScale.createMany({
    data: [
      { label: 'A+', minPercent: 90, maxPercent: 100, gradePoint: 4.0 },
      { label: 'A', minPercent: 80, maxPercent: 89.99, gradePoint: 3.7 },
      { label: 'B', minPercent: 70, maxPercent: 79.99, gradePoint: 3.0 },
      { label: 'C', minPercent: 60, maxPercent: 69.99, gradePoint: 2.0 },
      { label: 'D', minPercent: 50, maxPercent: 59.99, gradePoint: 1.0 },
      { label: 'F', minPercent: 0, maxPercent: 49.99, gradePoint: 0.0 },
    ].map((b) => ({ ...b, schoolId: sid, academicYearId: year.id })),
  });

  const mkUser = async (email: string, roles: Role[], hash: string, campusId: string | null) =>
    db.user.create({ data: { schoolId: sid, email, roles, status: 'ACTIVE', passwordHash: hash, passwordChangedAt: new Date(), campusId } });

  // Owner (school-wide).
  const owner = await mkUser('owner@demo.pk', ['OWNER_ADMIN'], ownerHash, null);
  creds.push({ role: 'Owner (OWNER_ADMIN)', who: 'School owner', email: owner.email, password: OWNER_PASSWORD, note: 'owner door /login' });

  const feeHead = await db.feeHead.create({ data: { schoolId: sid, name: 'Tuition' } });
  const now = new Date();
  const curMonth = now.getUTCMonth() + 1;
  const curYear = now.getUTCFullYear();
  const markDays = recentWorkingDays(12);

  // ── Main Campus ─────────────────────────────────────────────────────────────
  const mainStaffSpecs: StaffSpec[] = [
    { email: 'admin@demo.pk', roles: ['CAMPUS_ADMIN'], type: 'ADMIN', designation: 'Campus Administrator', campusBound: true, name: 'Nadia Khan' },
    { email: 'accountant@demo.pk', roles: ['ACCOUNTANT'], type: 'ACCOUNTANT', designation: 'Accountant', campusBound: true, name: 'Imran Malik' },
    { email: 'hr@demo.pk', roles: ['STAFF', 'HR_MANAGER'], type: 'ADMIN', designation: 'HR Manager', campusBound: true, name: 'Sadia Sheikh' },
    { email: 'admissions@demo.pk', roles: ['ADMISSION_CONTROLLER'], type: 'ADMIN', designation: 'Admission Officer', campusBound: true, name: 'Bilal Qureshi' },
    { email: 'ops@demo.pk', roles: ['STAFF', 'OPERATIONS_ADMIN'], type: 'ADMIN', designation: 'Operations Admin', campusBound: true, name: 'Kamran Rashid' },
  ];
  const mainTeacherNames = ['Ayesha Farooq', 'Usman Raza', 'Hira Ansari', 'Saad Baig', 'Maryam Javed'];
  mainTeacherNames.forEach((name, i) =>
    mainStaffSpecs.push({ email: `teacher${i + 1}@demo.pk`, roles: ['TEACHER'], type: 'TEACHER', designation: 'Teacher', campusBound: true, name }));

  const mainStaff = await createStaff(db, sid, mainCampus.id, mainStaffSpecs, staffHash, mkUser, counters);
  creds.push(...mainStaff.map((s) => ({ role: s.spec.roles.join(', '), who: s.spec.name, email: s.spec.email, password: STAFF_PASSWORD })));
  const mainTeachers = mainStaff.filter((s) => s.spec.type === 'TEACHER');

  const mainSections = await createClassesAndSections(db, sid, mainCampus.id, feeHead.id, year.id, ['A', 'B']);

  // Homeroom teachers: one teacher per section (cycling).
  for (let i = 0; i < mainSections.length; i++) {
    const t = mainTeachers[i % mainTeachers.length];
    await db.teacherAssignment.create({ data: { schoolId: sid, staffId: t.staffId, academicYearId: year.id, sectionId: mainSections[i].id, subjectId: null } });
  }

  const mainStudentLogins = await createStudents(db, sid, mainCampus.id, year.id, owner.id, feeHead.id, mainSections, markDays, curMonth, curYear, counters, 3);
  await createStaffAttendance(db, sid, mainStaff, markDays, owner.id);
  const mainEnrollments = await collectEnrollments(db, sid, mainSections);
  await createExamsAndReportCards(db, sid, term.id, owner.id, mainSections, mainEnrollments, 0);
  await createLeaveRecords(db, sid, owner.id, mainStaff, mainEnrollments);
  await createPayroll(db, sid, mainCampus.id, owner.id, mainStaff);

  // ── Girls Campus ────────────────────────────────────────────────────────────
  const girlsCampus = await db.campus.create({ data: { schoolId: sid, name: 'Falcon School Girls Campus', address: 'Gulberg III, Lahore' } });

  const girlsStaffSpecs: StaffSpec[] = [
    { email: 'g.admin@demo.pk', roles: ['CAMPUS_ADMIN'], type: 'ADMIN', designation: 'Campus Administrator', campusBound: true, name: 'Samina Akram' },
    { email: 'g.accountant@demo.pk', roles: ['ACCOUNTANT'], type: 'ACCOUNTANT', designation: 'Accountant', campusBound: true, name: 'Rubina Nawaz' },
    { email: 'g.teacher1@demo.pk', roles: ['TEACHER'], type: 'TEACHER', designation: 'Teacher', campusBound: true, name: 'Sobia Iqbal' },
    { email: 'g.teacher2@demo.pk', roles: ['TEACHER'], type: 'TEACHER', designation: 'Teacher', campusBound: true, name: 'Asma Farooq' },
    { email: 'g.teacher3@demo.pk', roles: ['TEACHER'], type: 'TEACHER', designation: 'Teacher', campusBound: true, name: 'Nazia Raza' },
  ];

  const girlsStaff = await createStaff(db, sid, girlsCampus.id, girlsStaffSpecs, staffHash, mkUser, counters);
  creds.push(...girlsStaff.map((s) => ({ role: s.spec.roles.join(', '), who: s.spec.name, email: s.spec.email, password: STAFF_PASSWORD })));
  const girlsTeachers = girlsStaff.filter((s) => s.spec.type === 'TEACHER');

  const girlsSections = await createClassesAndSections(db, sid, girlsCampus.id, feeHead.id, year.id, ['A']);

  for (let i = 0; i < girlsSections.length; i++) {
    const t = girlsTeachers[i % girlsTeachers.length];
    await db.teacherAssignment.create({ data: { schoolId: sid, staffId: t.staffId, academicYearId: year.id, sectionId: girlsSections[i].id, subjectId: null } });
  }

  const girlsStudentLogins = await createStudents(db, sid, girlsCampus.id, year.id, owner.id, feeHead.id, girlsSections, markDays, curMonth, curYear, counters, 2, true);
  await createStaffAttendance(db, sid, girlsStaff, markDays, owner.id);
  const girlsEnrollments = await collectEnrollments(db, sid, girlsSections);
  await createExamsAndReportCards(db, sid, term.id, owner.id, girlsSections, girlsEnrollments, 50);
  await createLeaveRecords(db, sid, owner.id, girlsStaff, girlsEnrollments);
  await createPayroll(db, sid, girlsCampus.id, owner.id, girlsStaff);

  // ── Finalise counters ───────────────────────────────────────────────────────
  await db.school.update({
    where: { id: sid },
    data: { grPrefix: 'GR-', nextGrNumber: counters.grSeq, registrationPrefix: 'REG-2026-', nextRegistrationNo: counters.regSeq },
  });
  await db.school.update({ where: { id: sid }, data: { nextReceiptNo: counters.receiptNo } });

  creds.push(...mainStudentLogins, ...girlsStudentLogins);
  return creds;
}

// ── helper: create staff ──────────────────────────────────────────────────────
async function createStaff(
  db: PrismaClient, sid: string, campusId: string, specs: StaffSpec[], staffHash: string,
  mkUser: (email: string, roles: Role[], hash: string, campusId: string | null) => Promise<{ id: string; email: string }>,
  counters: Counters,
): Promise<StaffInfo[]> {
  const result: StaffInfo[] = [];
  for (const s of specs) {
    const u = await mkUser(s.email, s.roles, staffHash, s.campusBound ? campusId : null);
    const staff = await db.staffProfile.create({
      data: {
        schoolId: sid, userId: u.id, staffType: s.type, employeeCode: `EMP-${String(counters.empSeq++).padStart(3, '0')}`,
        fullName: s.name, designation: s.designation, joinedAt: new Date('2024-04-01'),
      },
    });
    result.push({ staffId: staff.id, userId: u.id, spec: s });
  }
  return result;
}

// ── helper: create classes, sections, subjects, fee structures ────────────────
async function createClassesAndSections(
  db: PrismaClient, sid: string, campusId: string, feeHeadId: string, yearId: string,
  sectionNames: string[],
): Promise<SectionInfo[]> {
  const sections: SectionInfo[] = [];
  for (const c of CLASSES) {
    const klass = await db.class.create({ data: { schoolId: sid, campusId, name: c.name, order: c.order } });
    const subjectIds: string[] = [];
    for (const sub of SUBJECTS) {
      const s = await db.subject.create({ data: { schoolId: sid, classId: klass.id, name: sub, periodsPerWeek: sub === 'Mathematics' || sub === 'English' ? 6 : 4 } });
      subjectIds.push(s.id);
    }
    await db.feeStructure.create({
      data: { schoolId: sid, campusId, classId: klass.id, feeHeadId, academicYearId: yearId, amount: c.tuition, frequency: 'MONTHLY', effectiveFrom: new Date('2026-04-01') },
    });
    for (const secName of sectionNames) {
      const sec = await db.section.create({ data: { schoolId: sid, classId: klass.id, name: secName } });
      sections.push({ id: sec.id, classId: klass.id, className: c.name, label: `${c.name}-${secName}`, subjectIds });
    }
  }
  return sections;
}

// ── helper: create students with guardians, enrolments, invoices, attendance ──
async function createStudents(
  db: PrismaClient, sid: string, campusId: string, yearId: string, ownerId: string,
  feeHeadId: string, sections: SectionInfo[], markDays: Date[], curMonth: number, curYear: number,
  counters: Counters, portalCount: number, allFemale = false,
): Promise<Cred[]> {
  const tuitionOf = (className: string) => CLASSES.find((c) => c.name === className)!.tuition;
  const logins: Cred[] = [];
  let localIdx = 0;

  for (const sec of sections) {
    for (let r = 1; r <= 5; r++) {
      const male = allFemale ? false : localIdx % 2 === 0;
      const nameOffset = allFemale ? localIdx + 30 : localIdx;
      const first = male ? pick(MALE, nameOffset) : pick(FEMALE, nameOffset);
      const last = pick(LAST, nameOffset + 3);
      const fullName = `${first} ${last}`;
      const gr = `GR-${String(counters.grSeq++).padStart(4, '0')}`;
      const regNo = `REG-2026-${String(counters.regSeq++).padStart(4, '0')}`;
      const globalIdx = counters.grSeq - 2;
      const cnic = `35201${String(1000000 + globalIdx).padStart(7, '0')}${male ? '1' : '2'}`;

      const givePortal = localIdx < portalCount;
      let studentUserId: string | null = null;
      if (givePortal) {
        const su = await db.user.create({ data: { schoolId: sid, email: `student${counters.studentUserSeq++}@demo.pk`, roles: ['STUDENT'], status: 'ACTIVE', campusId } });
        studentUserId = su.id;
      }

      const student = await db.student.create({
        data: {
          schoolId: sid, grNumber: gr, registrationNo: regNo, fullName, gender: male ? 'MALE' : 'FEMALE',
          dateOfBirth: new Date(Date.UTC(2013 - Math.floor(globalIdx / 6), (globalIdx % 12), 5)),
          city: 'Lahore', addressLine: `House ${100 + globalIdx}, ${allFemale ? 'Gulberg III' : 'Model Town'}`, nationality: 'Pakistani',
          status: 'ACTIVE', isActive: true, createdById: ownerId,
          ...(givePortal ? { userId: studentUserId, cnicHash: hashCnic(cnic) } : {}),
        },
      });

      const guardianName = `${pick(MALE, globalIdx + 5)} ${last}`;
      const phoneVerified = globalIdx % 10 !== 0;
      const parent = await db.parentProfile.create({
        data: {
          schoolId: sid, fullName: guardianName,
          phone: `+92300${String(1000000 + globalIdx).padStart(7, '0')}`,
          occupation: pick(['Businessman', 'Doctor', 'Engineer', 'Teacher', 'Shopkeeper'], globalIdx),
          ...(phoneVerified ? { phoneVerifiedAt: new Date('2026-04-05') } : {}),
        },
      });
      await db.studentGuardian.create({ data: { schoolId: sid, studentId: student.id, parentId: parent.id, relation: 'FATHER', isPrimary: true } });

      const enrol = await db.studentEnrollment.create({
        data: { schoolId: sid, studentId: student.id, academicYearId: yearId, campusId, classId: sec.classId, sectionId: sec.id, rollNumber: r, status: 'ACTIVE', startedAt: new Date('2026-04-01') },
      });

      const tuition = tuitionOf(sec.className);
      const dueDay = 10;
      const bucket = globalIdx % 20;
      const overdue = bucket < 3;
      const dueDate = overdue ? new Date(Date.UTC(curYear, curMonth - 2, dueDay)) : new Date(Date.UTC(curYear, curMonth - 1, dueDay));
      const paidFull = bucket >= 3 && bucket < 14;
      const partial = bucket >= 14 && bucket < 17;
      const paidAmount = paidFull ? tuition : partial ? Math.round(tuition / 2) : 0;
      const status = paidFull ? 'PAID' : partial ? 'PARTIAL' : overdue ? 'OVERDUE' : 'PENDING';
      const invoice = await db.feeInvoice.create({
        data: {
          schoolId: sid, studentId: student.id, enrollmentId: enrol.id, totalAmount: tuition, paidAmount,
          dueDate, status, month: overdue ? (curMonth === 1 ? 12 : curMonth - 1) : curMonth, year: curYear,
        },
      });
      await db.feeInvoiceItem.create({ data: { schoolId: sid, invoiceId: invoice.id, type: 'FEE', feeHeadId, description: `Tuition — ${sec.className}`, amount: tuition } });
      if (paidAmount > 0) {
        await db.feePayment.create({
          data: { schoolId: sid, invoiceId: invoice.id, receiptNo: counters.receiptNo++, amountPaid: paidAmount, method: 'CASH', collectedById: ownerId, paidAt: new Date(Date.UTC(curYear, curMonth - 1, 5)) },
        });
      }

      for (const d of markDays) {
        const seed = (globalIdx * 7 + d.getUTCDate()) % 20;
        const st = seed === 0 ? 'ABSENT' : seed === 1 ? 'LATE' : seed === 2 ? 'ON_LEAVE' : 'PRESENT';
        await db.attendanceRecord.create({ data: { schoolId: sid, enrollmentId: enrol.id, date: d, session: 'MORNING', status: st, markedById: ownerId } });
      }

      if (givePortal) logins.push({ role: 'Student (portal)', who: fullName, note: `door /login (student) · Registration No ${regNo} · CNIC ${cnic}` });
      localIdx++;
    }
  }
  return logins;
}

// ── helper: staff attendance ──────────────────────────────────────────────────
async function createStaffAttendance(db: PrismaClient, sid: string, staff: StaffInfo[], markDays: Date[], ownerId: string) {
  for (const [ti, s] of staff.entries()) {
    for (const d of markDays) {
      const seed = (ti * 5 + d.getUTCDate()) % 15;
      const st = seed === 0 ? 'ABSENT' : seed === 1 ? 'LATE' : 'PRESENT';
      await db.staffAttendance.create({ data: { schoolId: sid, staffId: s.staffId, date: d, session: 'MORNING', status: st, source: 'ADMIN', markedById: ownerId } });
    }
  }
}

// ── helper: collect enrollments from sections ─────────────────────────────────
async function collectEnrollments(db: PrismaClient, sid: string, sections: SectionInfo[]) {
  const enrollments: { id: string; sectionId: string; classId: string; studentId: string }[] = [];
  for (const sec of sections) {
    const rows = await db.studentEnrollment.findMany({
      where: { schoolId: sid, sectionId: sec.id, status: 'ACTIVE' },
      select: { id: true, sectionId: true, classId: true, studentId: true },
    });
    enrollments.push(...rows);
  }
  return enrollments;
}

// ── helper: exams, marks, report cards ────────────────────────────────────────
async function createExamsAndReportCards(
  db: PrismaClient, sid: string, termId: string, ownerId: string,
  sections: SectionInfo[],
  enrollments: { id: string; sectionId: string; classId: string; studentId: string }[],
  markSeed: number,
) {
  const classIds = [...new Set(sections.map((s) => s.classId))];

  for (const classId of classIds) {
    const exam = await db.examDefinition.create({
      data: {
        schoolId: sid, termId, classId, name: 'Mid-Term', examType: 'MID_TERM',
        weightagePercent: 100, examDate: new Date('2026-08-15'), status: 'PUBLISHED',
        publishedAt: new Date('2026-08-20'), publishedById: ownerId,
      },
    });

    const classSections = sections.filter((s) => s.classId === classId);
    const classEnrollments = enrollments.filter((e) => e.classId === classId);

    const studentMarks = new Map<string, number[]>();

    for (const enrol of classEnrollments) {
      const sec = classSections.find((s) => s.id === enrol.sectionId)!;
      const marks: number[] = [];
      for (let si = 0; si < sec.subjectIds.length; si++) {
        const m = 40 + ((markSeed + parseInt(enrol.id.slice(-4), 16) + si * 17) % 56);
        marks.push(m);
        await db.examResult.create({
          data: {
            schoolId: sid, examId: exam.id, enrollmentId: enrol.id, subjectId: sec.subjectIds[si],
            marksObtained: m, totalMarks: 100, isAbsent: false, enteredById: ownerId,
          },
        });
      }
      studentMarks.set(enrol.id, marks);
    }

    // Report cards per section (dense rank within section).
    for (const sec of classSections) {
      const secEnrollments = classEnrollments.filter((e) => e.sectionId === sec.id);
      const scored = secEnrollments.map((e) => {
        const marks = studentMarks.get(e.id)!;
        const avg = marks.reduce((a, b) => a + b, 0) / marks.length;
        return { enrollmentId: e.id, avg };
      }).sort((a, b) => b.avg - a.avg);

      let rank = 0;
      let prevAvg = -1;
      for (const s of scored) {
        if (s.avg !== prevAvg) rank++;
        prevAvg = s.avg;
        await db.reportCard.create({
          data: { schoolId: sid, termId, enrollmentId: s.enrollmentId, overallPercent: Math.round(s.avg * 100) / 100, gradeLabel: gradeOf(s.avg), sectionRank: rank },
        });
      }
    }
  }
}

// ── helper: leave records ─────────────────────────────────────────────────────
async function createLeaveRecords(
  db: PrismaClient, sid: string, ownerId: string, staff: StaffInfo[],
  enrollments: { id: string; sectionId: string; classId: string; studentId: string }[],
) {
  const adminUser = staff.find((s) => s.spec.roles.includes('CAMPUS_ADMIN'));
  const deciderId = adminUser?.userId ?? ownerId;

  // Student leaves
  if (enrollments.length >= 3) {
    await db.studentLeave.create({
      data: { schoolId: sid, studentId: enrollments[0].studentId, fromDate: new Date('2026-08-10'), toDate: new Date('2026-08-12'), reason: 'Family wedding', status: 'APPROVED', requestedById: ownerId, decidedById: deciderId, decidedAt: new Date('2026-08-09') },
    });
    await db.studentLeave.create({
      data: { schoolId: sid, studentId: enrollments[1].studentId, fromDate: new Date('2026-10-05'), toDate: new Date('2026-10-06'), reason: 'Medical appointment', status: 'PENDING', requestedById: ownerId },
    });
    await db.studentLeave.create({
      data: { schoolId: sid, studentId: enrollments[2].studentId, fromDate: new Date('2026-09-15'), toDate: new Date('2026-09-17'), reason: 'Vacation trip', status: 'REJECTED', rejectionReason: 'Exams approaching', requestedById: ownerId, decidedById: deciderId, decidedAt: new Date('2026-09-14') },
    });
  }

  // Staff leaves
  const teachers = staff.filter((s) => s.spec.type === 'TEACHER');
  if (teachers.length >= 2) {
    await db.staffLeave.create({
      data: { schoolId: sid, staffId: teachers[0].staffId, leaveType: 'CASUAL', fromDate: new Date('2026-08-20'), toDate: new Date('2026-08-21'), reason: 'Personal work', status: 'APPROVED', decidedById: ownerId, decidedAt: new Date('2026-08-19') },
    });
    await db.staffLeave.create({
      data: { schoolId: sid, staffId: teachers[1].staffId, leaveType: 'SICK', fromDate: new Date('2026-10-03'), toDate: new Date('2026-10-04'), reason: 'Flu', status: 'PENDING' },
    });
  }
  if (staff.length >= 3) {
    const nonTeacher = staff.find((s) => s.spec.type !== 'TEACHER');
    if (nonTeacher) {
      await db.staffLeave.create({
        data: { schoolId: sid, staffId: nonTeacher.staffId, leaveType: 'UNPAID', fromDate: new Date('2026-09-25'), toDate: new Date('2026-09-26'), reason: 'Out of station', status: 'REJECTED', isUnpaid: true, rejectionReason: 'Month-end closing', decidedById: ownerId, decidedAt: new Date('2026-09-24') },
      });
    }
  }
}

// ── helper: salary + payroll ──────────────────────────────────────────────────
async function createPayroll(db: PrismaClient, sid: string, campusId: string, ownerId: string, staff: StaffInfo[]) {
  const salaryByDesignation: Record<string, number> = {
    'Operations Admin': 45000, 'Campus Administrator': 40000, 'HR Manager': 38000,
    'Accountant': 35000, 'Admission Officer': 32000, 'Teacher': 30000,
  };
  const allowances = { 'House Rent': 5000, 'Transport': 3000 };
  const deductions = { EOBI: 500 };
  const allowanceTotal = Object.values(allowances).reduce((a, b) => a + b, 0);
  const deductionTotal = Object.values(deductions).reduce((a, b) => a + b, 0);

  for (const s of staff) {
    const basic = salaryByDesignation[s.spec.designation] ?? 30000;
    await db.salaryStructure.create({
      data: { schoolId: sid, staffId: s.staffId, basic, allowances, fixedDeductions: deductions, effectiveFrom: new Date('2026-04-01') },
    });
  }

  const run = await db.payrollRun.create({
    data: { schoolId: sid, campusId, month: 9, year: 2026, status: 'DRAFT', createdById: ownerId },
  });

  for (const s of staff) {
    const basic = salaryByDesignation[s.spec.designation] ?? 30000;
    const gross = basic + allowanceTotal;
    const netPay = gross - deductionTotal;
    await db.payslip.create({
      data: {
        schoolId: sid, runId: run.id, staffId: s.staffId, gross, attendanceDeduction: 0,
        otherDeductions: deductionTotal, netPay,
        breakdown: { basic, allowances, deductions, gross, netPay },
      },
    });
  }
}

// ── utility ───────────────────────────────────────────────────────────────────

/** The last `n` working days (skip Sundays), oldest first, as UTC date-only. */
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

function writeCreds(creds: Cred[]) {
  const lines = [
    '# Seed credentials — Falcon School System (demo tenant)',
    '',
    'Host: **demo.localhost** · owner-web :3005 · staff-web :3006 · student-web :3003',
    '',
    '| Role | Name | Email / login | Password |',
    '|------|------|---------------|----------|',
    ...creds.map((c) => `| ${c.role} | ${c.who} | ${c.email ?? c.note ?? ''} | ${c.password ?? '(reg-no + CNIC)'} |`),
    '',
    '_Students sign in at the student door with Registration No + CNIC (no password). Staff and owner use email + password._',
    '',
    `_Generated ${new Date().toISOString()} by scripts/seed-real-school.ts_`,
  ];
  writeFileSync(join(process.cwd(), 'SEED-CREDENTIALS.md'), `${lines.join('\n')}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
