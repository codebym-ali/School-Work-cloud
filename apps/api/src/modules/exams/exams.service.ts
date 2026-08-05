import { HttpStatus, Injectable } from '@nestjs/common';
import { ExamStatus } from '@prisma/client';
import {
  AppError,
  assertCampusAccess,
  ErrorCodes,
  restrictedCampusId,
  TenantContext,
  type RequestUser,
} from '@common';
import { TenantPrismaService } from '@database';
import type { BulkMarksDto, CreateExamDto, MarkRowDto } from './dto/exams.dto';

export interface BulkResult {
  succeeded: number;
  failed: number;
  errors: Array<{ index: number; code: string; message: string }>;
}

/** Exam definitions, marks entry, and publication (blueprint §11). */
@Injectable()
export class ExamsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  async createExam(dto: CreateExamDto) {
    // The exam's campus is its class's campus — a campus-bound user can't create for another.
    const klass = await this.db.class.findFirst({ where: { id: dto.classId }, select: { campusId: true } });
    if (!klass) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Class not found');
    assertCampusAccess(this.ctx.user, klass.campusId);
    return this.db.examDefinition.create({
      data: {
        schoolId: this.sid,
        termId: dto.termId,
        classId: dto.classId,
        name: dto.name,
        examType: dto.examType,
        weightagePercent: dto.weightagePercent,
        examDate: new Date(dto.examDate),
        status: ExamStatus.DRAFT,
      },
    });
  }

  listExams(classId?: string, termId?: string) {
    // Campus-bound users only see exams for classes in their campus.
    const restricted = restrictedCampusId(this.ctx.user);
    return this.db.examDefinition.findMany({
      where: {
        ...(classId ? { classId } : {}),
        ...(termId ? { termId } : {}),
        ...(restricted ? { class: { campusId: restricted } } : {}),
      },
      orderBy: { examDate: 'asc' },
    });
  }

  async openMarksEntry(id: string) {
    const exam = await this.getExam(id);
    if (exam.status !== ExamStatus.DRAFT) {
      throw new AppError(ErrorCodes.INVALID_STATE_TRANSITION, HttpStatus.CONFLICT, `Exam is ${exam.status}`);
    }
    return this.db.examDefinition.update({ where: { id }, data: { status: ExamStatus.MARKS_ENTRY } });
  }

  /** Bulk upsert marks (partial-failure, §25.3). Teachers may only mark their assigned subject. */
  async enterMarks(examId: string, dto: BulkMarksDto): Promise<BulkResult> {
    const exam = await this.getExam(examId);
    if (exam.status === ExamStatus.PUBLISHED) {
      throw new AppError(ErrorCodes.INVALID_STATE_TRANSITION, HttpStatus.CONFLICT, 'Exam is PUBLISHED; use the correction endpoint');
    }
    const term = await this.db.term.findFirst({ where: { id: exam.termId } });
    const subjectIds = new Set((await this.db.subject.findMany({ where: { classId: exam.classId } })).map((s) => s.id));

    const errors: BulkResult['errors'] = [];
    let succeeded = 0;
    for (let i = 0; i < dto.records.length; i++) {
      const r = dto.records[i];
      const err = await this.validateRow(exam.classId, term!.academicYearId, subjectIds, r, this.ctx.user!);
      if (err) {
        errors.push({ index: i, code: err.code, message: err.message });
        continue;
      }
      const isAbsent = r.isAbsent ?? false;
      const marksObtained = isAbsent ? null : r.marksObtained!;
      const existing = await this.db.examResult.findFirst({ where: { examId, enrollmentId: r.enrollmentId, subjectId: r.subjectId } });
      if (existing) {
        await this.db.examResult.update({ where: { id: existing.id }, data: { marksObtained, totalMarks: r.totalMarks, isAbsent, enteredById: this.ctx.user!.userId } });
      } else {
        await this.db.examResult.create({
          data: { schoolId: this.sid, examId, enrollmentId: r.enrollmentId, subjectId: r.subjectId, marksObtained, totalMarks: r.totalMarks, isAbsent, enteredById: this.ctx.user!.userId },
        });
      }
      succeeded++;
    }
    return { succeeded, failed: errors.length, errors };
  }

  async getResults(examId: string) {
    await this.getExam(examId); // asserts campus access
    return this.db.examResult.findMany({
      where: { examId },
      // Carries the student's NAME, not just their id. The results screen used to look the name
      // up client-side in a map built from `/students?pageSize=100` — so in any school past 100
      // students it rendered a truncated UUID instead of a child's name. A list must carry the
      // names it displays; the same rule the teaching-assignment rework landed on.
      include: {
        subject: { select: { name: true } },
        enrollment: { select: { studentId: true, sectionId: true, student: { select: { fullName: true, grNumber: true } } } },
      },
    });
  }

  /**
   * Publish (blueprint §11): completeness gate — every (enrolled student × class subject)
   * must have a mark or isAbsent, else 422 RESULTS_INCOMPLETE with the missing list.
   */
  async publish(id: string) {
    const exam = await this.getExam(id);
    if (exam.status !== ExamStatus.MARKS_ENTRY) {
      throw new AppError(ErrorCodes.INVALID_STATE_TRANSITION, HttpStatus.CONFLICT, `Exam is ${exam.status}, not MARKS_ENTRY`);
    }
    const term = await this.db.term.findFirst({ where: { id: exam.termId } });
    const subjects = await this.db.subject.findMany({ where: { classId: exam.classId } });
    const enrollments = await this.db.studentEnrollment.findMany({ where: { classId: exam.classId, academicYearId: term!.academicYearId, status: 'ACTIVE' } });
    const results = await this.db.examResult.findMany({ where: { examId: id } });
    const have = new Set(results.map((r) => `${r.enrollmentId}:${r.subjectId}`));

    const missing: Array<{ enrollmentId: string; subjectId: string }> = [];
    for (const e of enrollments) {
      for (const s of subjects) {
        if (!have.has(`${e.id}:${s.id}`)) missing.push({ enrollmentId: e.id, subjectId: s.id });
      }
    }
    if (missing.length > 0) {
      throw new AppError(ErrorCodes.RESULTS_INCOMPLETE, HttpStatus.UNPROCESSABLE_ENTITY, `${missing.length} result(s) missing`, missing.slice(0, 50).map((m) => ({ field: m.enrollmentId, issue: m.subjectId })));
    }
    return this.db.examDefinition.update({ where: { id }, data: { status: ExamStatus.PUBLISHED, publishedAt: new Date(), publishedById: this.ctx.user!.userId } });
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
  private async getExam(id: string) {
    const exam = await this.db.examDefinition.findFirst({
      where: { id },
      include: { class: { select: { campusId: true } } },
    });
    if (!exam) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Exam not found');
    // Gates openMarksEntry / enterMarks / getResults / publish (all route through here).
    assertCampusAccess(this.ctx.user, exam.class.campusId);
    return exam;
  }

  private async validateRow(
    classId: string,
    academicYearId: string,
    subjectIds: Set<string>,
    r: MarkRowDto,
    user: RequestUser,
  ): Promise<{ code: string; message: string } | null> {
    if (!subjectIds.has(r.subjectId)) return { code: ErrorCodes.VALIDATION_FAILED, message: 'Subject not in this class' };
    const enr = await this.db.studentEnrollment.findFirst({ where: { id: r.enrollmentId } });
    if (!enr || enr.status !== 'ACTIVE' || enr.classId !== classId || enr.academicYearId !== academicYearId) {
      return { code: ErrorCodes.VALIDATION_FAILED, message: 'Enrollment not ACTIVE in this class/year' };
    }
    if (r.isAbsent) {
      // absent → no marks needed
    } else {
      if (r.marksObtained == null) return { code: ErrorCodes.VALIDATION_FAILED, message: 'marksObtained required unless absent' };
      if (r.marksObtained > r.totalMarks) return { code: ErrorCodes.VALIDATION_FAILED, message: 'marksObtained exceeds totalMarks' };
    }
    // Teacher may only enter marks for their assigned (section, subject).
    if (!isAdmin(user) && user.roles.includes('TEACHER')) {
      const staff = await this.db.staffProfile.findFirst({ where: { userId: user.userId } });
      const assignment = staff
        ? await this.db.teacherAssignment.findFirst({ where: { staffId: staff.id, academicYearId, sectionId: enr.sectionId, subjectId: r.subjectId } })
        : null;
      if (!assignment) return { code: ErrorCodes.FORBIDDEN, message: 'Not assigned to this section/subject' };
    }
    return null;
  }
}

function isAdmin(user: RequestUser): boolean {
  return user.roles.includes('OWNER_ADMIN') || user.roles.includes('CAMPUS_ADMIN');
}
