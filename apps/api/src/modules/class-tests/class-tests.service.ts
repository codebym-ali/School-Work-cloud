import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AppError,
  assertCampusAccess,
  ErrorCodes,
  restrictedCampusId,
  TenantContext,
  type RequestUser,
} from '@common';
import { TenantPrismaService } from '@database';
import { SetupService } from '../setup/setup.service';
import type {
  CreateClassTestDto,
  ListClassTestQuery,
  SetClassTestScoresDto,
  UpdateClassTestDto,
} from './dto/class-test.dto';

/**
 * Class tests (§11 extension) — formative assessment owned by the subject teacher.
 *
 * Deliberately NOT part of the exam system: an `ExamDefinition` carries `weightagePercent` that
 * must sum to 100 across a class and feeds report-card generation, so an ad-hoc quiz modelled as
 * an exam would both break the weightage invariant and be demanded by the publish completeness
 * gate. A class test never touches a report card.
 */
@Injectable()
export class ClassTestsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly setup: SetupService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get user(): RequestUser {
    return this.ctx.user!;
  }

  async create(dto: CreateClassTestDto) {
    const section = await this.sectionOr404(dto.sectionId);
    await this.assertMayTeach(dto.sectionId, dto.subjectId);

    // The subject must belong to the section's class — and, when the section opts into its own
    // list (electives), to that list. Otherwise a teacher could set a Biology test for a section
    // that doesn't study Biology, and it would surface in that student's report as a real gap.
    const subject = await this.db.subject.findFirst({ where: { id: dto.subjectId } });
    if (!subject || subject.classId !== section.classId) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Subject is not taught in this class');
    }
    const own = await this.db.sectionSubject.findMany({ where: { sectionId: dto.sectionId }, select: { subjectId: true } });
    if (own.length && !own.some((o) => o.subjectId === dto.subjectId)) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'This section does not study that subject');
    }

    if (new Date(dto.testDate) > new Date()) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'Test date is in the future');
    }

    return this.db.classTest.create({
      data: {
        schoolId: this.ctx.requireSchoolId(),
        sectionId: dto.sectionId,
        subjectId: dto.subjectId,
        name: dto.name.trim(),
        totalMarks: dto.totalMarks,
        testDate: new Date(dto.testDate),
        createdById: this.user.userId,
      },
    });
  }

  /** Tests for a section/subject. A teacher sees only sections they teach. */
  async list(q: ListClassTestQuery) {
    const restricted = restrictedCampusId(this.user);
    const mine = await this.mySectionIds();

    const tests = await this.db.classTest.findMany({
      where: {
        ...(q.sectionId ? { sectionId: q.sectionId } : {}),
        ...(q.subjectId ? { subjectId: q.subjectId } : {}),
        ...(mine ? { sectionId: { in: mine } } : {}),
        ...(restricted ? { section: { class: { campusId: restricted } } } : {}),
      },
      include: {
        subject: { select: { name: true } },
        section: { select: { name: true, class: { select: { id: true, name: true } } } },
        _count: { select: { scores: true } },
      },
      orderBy: { testDate: 'desc' },
      take: 200,
    });
    return tests.map(({ _count, ...t }) => ({ ...t, scoreCount: _count.scores }));
  }

  async getOne(id: string) {
    const test = await this.db.classTest.findFirst({
      where: { id },
      include: {
        subject: { select: { name: true } },
        section: { select: { name: true, classId: true, class: { select: { name: true, campusId: true } } } },
        scores: true,
      },
    });
    if (!test) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Class test not found');
    assertCampusAccess(this.user, test.section.class.campusId);
    const mine = await this.mySectionIds();
    if (mine && !mine.includes(test.sectionId)) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'You do not teach this section');
    }
    return test;
  }

  async update(id: string, dto: UpdateClassTestDto) {
    const test = await this.getOne(id);
    await this.assertOwner(test.createdById);

    // Lowering the total below a mark already entered would silently make that score impossible
    // (18 out of a test now worth 10). Refuse and name the students, rather than corrupt marks.
    if (dto.totalMarks != null) {
      const over = test.scores.filter((s) => s.marksObtained != null && Number(s.marksObtained) > dto.totalMarks!);
      if (over.length) {
        throw new AppError(
          ErrorCodes.CONFLICT,
          HttpStatus.CONFLICT,
          `${over.length} student(s) already scored more than ${dto.totalMarks}. Correct those marks first, or set a higher total.`,
        );
      }
    }

    return this.db.classTest.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.totalMarks !== undefined ? { totalMarks: dto.totalMarks } : {}),
        ...(dto.testDate !== undefined ? { testDate: new Date(dto.testDate) } : {}),
      },
    });
  }

  async remove(id: string) {
    const test = await this.getOne(id);
    await this.assertOwner(test.createdById);
    // Deleting a test destroys every mark on it. Refuse while marks exist and say how many —
    // the same guard style used for classes, sections and terms.
    if (test.scores.length) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        `“${test.name}” has ${test.scores.length} mark(s) recorded — clear them first if you really mean to delete it.`,
      );
    }
    await this.db.classTest.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * Enter or correct marks. Partial-failure contract (§25.3), matching attendance and exam
   * marks entry: one bad row never rejects a whole register the teacher just typed.
   */
  async setScores(id: string, dto: SetClassTestScoresDto) {
    const test = await this.getOne(id);
    await this.assertMayTeach(test.sectionId, test.subjectId);
    const total = Number(test.totalMarks);
    const academicYearId = await this.setup.requireCurrentYearId();

    const errors: Array<{ index: number; code: string; message: string }> = [];
    let saved = 0;

    for (let i = 0; i < dto.rows.length; i++) {
      const r = dto.rows[i];
      const absent = r.isAbsent === true;

      if (!absent && r.marksObtained == null) {
        errors.push({ index: i, code: ErrorCodes.VALIDATION_FAILED, message: 'Marks required unless the student was absent' });
        continue;
      }
      if (absent && r.marksObtained != null) {
        errors.push({ index: i, code: ErrorCodes.VALIDATION_FAILED, message: 'A student marked absent cannot also have marks' });
        continue;
      }
      if (!absent && r.marksObtained! > total) {
        errors.push({ index: i, code: ErrorCodes.VALIDATION_FAILED, message: `Marks cannot exceed the total of ${total}` });
        continue;
      }

      const enr = await this.db.studentEnrollment.findFirst({
        where: { id: r.enrollmentId, student: { deletedAt: null } },
      });
      if (!enr || enr.status !== 'ACTIVE' || enr.sectionId !== test.sectionId || enr.academicYearId !== academicYearId) {
        errors.push({ index: i, code: ErrorCodes.VALIDATION_FAILED, message: 'Student is not actively enrolled in this section' });
        continue;
      }

      // Find-then-write: `upsert` is unsafe on tenant models (the extension merges schoolId into
      // the where clause and breaks the unique selector) — see Key Decisions.
      const existing = await this.db.classTestScore.findFirst({
        where: { classTestId: id, enrollmentId: r.enrollmentId },
      });
      const data = { marksObtained: absent ? null : r.marksObtained!, isAbsent: absent };
      if (existing) {
        await this.db.classTestScore.update({ where: { id: existing.id }, data });
      } else {
        await this.db.classTestScore.create({
          data: { schoolId: this.ctx.requireSchoolId(), classTestId: id, enrollmentId: r.enrollmentId, ...data },
        });
      }
      saved++;
    }

    return { saved, failed: errors.length, errors };
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private async sectionOr404(sectionId: string) {
    const section = await this.db.section.findFirst({
      where: { id: sectionId },
      include: { class: { select: { campusId: true } } },
    });
    if (!section) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Section not found');
    assertCampusAccess(this.user, section.class.campusId);
    return section;
  }

  /** The sections a TEACHER is assigned to, or null for an admin (unrestricted). */
  private async mySectionIds(): Promise<string[] | null> {
    if (this.isAdmin()) return null;
    const staff = await this.db.staffProfile.findFirst({ where: { userId: this.user.userId } });
    if (!staff) return [];
    const academicYearId = await this.setup.requireCurrentYearId();
    const rows = await this.db.teacherAssignment.findMany({
      where: { staffId: staff.id, academicYearId },
      select: { sectionId: true },
    });
    return [...new Set(rows.map((r) => r.sectionId))];
  }

  /** A teacher may only set or mark a test for a (section, subject) they actually teach. */
  private async assertMayTeach(sectionId: string, subjectId: string): Promise<void> {
    if (this.isAdmin()) return;
    if (!this.user.roles.includes('TEACHER')) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Not permitted to set class tests');
    }
    const staff = await this.db.staffProfile.findFirst({ where: { userId: this.user.userId } });
    const academicYearId = await this.setup.requireCurrentYearId();
    const assignment = staff
      ? await this.db.teacherAssignment.findFirst({ where: { staffId: staff.id, academicYearId, sectionId, subjectId } })
      : null;
    if (!assignment) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'You are not assigned to teach this subject in this section');
    }
  }

  /** Edits and deletion belong to whoever set the test; admins may always step in. */
  private async assertOwner(createdById: string | null): Promise<void> {
    if (this.isAdmin()) return;
    if (createdById !== this.user.userId) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Only the teacher who set this test can change it');
    }
  }

  private isAdmin(): boolean {
    return this.user.roles.includes('OWNER_ADMIN') || this.user.roles.includes('CAMPUS_ADMIN');
  }
}
