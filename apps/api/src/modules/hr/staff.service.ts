import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, Role, StaffType } from '@prisma/client';
import { AppError, assertCampusAccess, assertSameCampus, AuditActions, ErrorCodes, restrictedCampusId, TenantContext } from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { PasswordService } from '../auth/password.service';
import { AccessService } from '../access/access.service';
import type { CreateSalaryStructureDto, CreateStaffDto, CreateTeacherAssignmentDto } from './dto/hr.dto';

/** Staff HR (blueprint §13): profiles for all staff types, salary structures, teacher assignments. */
@Injectable()
export class StaffService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  /** Create a User + StaffProfile in one operation. Supplying `password` makes the login
   *  usable straight away; omitting it leaves the account INVITED until a password is set. */
  async createStaff(dto: CreateStaffDto) {
    await this.access.assert('hr.staff');
    // A campus-bound admin can only create staff in their own campus (§22.8).
    assertCampusAccess(this.ctx.user, dto.campusId ?? null);
    const roles = dto.roles ?? defaultRoles(dto.staffType);

    // The unique indexes on (school, email) and (school, employeeCode) span SOFT-DELETED rows,
    // but the staff directory hides them — so a removed colleague silently blocks the value and
    // the raw P2002 below could name neither the field nor a record the operator can see.
    // Pre-check instead, and say plainly when the clash is with a removed record.
    const email = dto.email.toLowerCase();
    const [emailOwner, codeOwner] = await Promise.all([
      // Only a LIVE account blocks the address. The unique index is partial
      // (WHERE deleted_at IS NULL), so a removed colleague's email is reusable — this
      // pre-check exists for the message, and must not be stricter than the constraint.
      this.db.user.findFirst({ where: { email, deletedAt: null }, select: { deletedAt: true } }),
      this.db.staffProfile.findFirst({
        where: { employeeCode: dto.employeeCode },
        select: { user: { select: { deletedAt: true } } },
      }),
    ]);
    if (emailOwner) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        `Someone already uses the email ${email}.`,
        [{ field: 'email', issue: 'duplicate' }],
      );
    }
    if (codeOwner) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        HttpStatus.CONFLICT,
        codeOwner.user?.deletedAt
          ? `Employee code ${dto.employeeCode} still belongs to a removed staff member. Use a different code.`
          : `Employee code ${dto.employeeCode} is already in use.`,
        [{ field: 'employeeCode', issue: codeOwner.user?.deletedAt ? 'taken-by-removed' : 'duplicate' }],
      );
    }

    // With a password the account is ACTIVE and can sign in immediately; without one it stays
    // INVITED (no passwordHash) and an owner has to set a password before the teacher can log in.
    const passwordHash = dto.password ? await this.passwords.hash(dto.password) : null;

    try {
      const user = await this.db.user.create({
        data: {
          schoolId: this.sid,
          email: dto.email.toLowerCase(),
          roles,
          status: passwordHash ? 'ACTIVE' : 'INVITED',
          passwordHash,
          passwordChangedAt: passwordHash ? new Date() : null,
          campusId: dto.campusId,
        },
      });
      const staff = await this.db.staffProfile.create({
        data: {
          schoolId: this.sid,
          userId: user.id,
          staffType: dto.staffType,
          employeeCode: dto.employeeCode,
          fullName: dto.fullName,
          designation: dto.designation,
          joinedAt: new Date(dto.joinedAt),
        },
      });
      return {
        userId: user.id, staffId: staff.id, employeeCode: staff.employeeCode,
        email: user.email, loginActive: Boolean(passwordHash),
      };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Email or employeeCode already exists');
      }
      throw e;
    }
  }

  listStaff(staffType?: StaffType) {
    // Campus-bound users only see staff assigned to their campus (via the User row).
    // Excludes staff whose linked User was removed (soft-deleted) — a removed login
    // should disappear from the directory the same way it does from /users.
    const restricted = restrictedCampusId(this.ctx.user);
    return this.db.staffProfile.findMany({
      where: {
        ...(staffType ? { staffType } : {}),
        user: { deletedAt: null, ...(restricted ? { campusId: restricted } : {}) },
      },
      include: { user: { select: { id: true, email: true, roles: true, status: true, campusId: true, campus: { select: { name: true } } } } },
      orderBy: { employeeCode: 'asc' },
    });
  }

  /**
   * HR rollup for whoever owns the staff record — campus-scoped exactly like `listStaff`.
   *
   * Replaces the deleted recruitment summary, and answers the questions that make the HR role
   * more than data entry:
   *  • how many people work here, and how many joined recently
   *  • who is only half set up (a record exists, but they cannot sign in or teach anything)
   *  • where the school is SHORT of teachers
   *
   * That last one is the important substitution. A vacancy board had to be maintained by hand
   * and went stale the moment someone forgot. Coverage is instead DERIVED from the real class
   * structure: every (section, subject) the school teaches that has nobody assigned this year.
   */
  async hrSummary() {
    const restricted = restrictedCampusId(this.ctx.user);
    const staffWhere: Prisma.StaffProfileWhereInput = {
      user: { deletedAt: null, ...(restricted ? { campusId: restricted } : {}) },
    };

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearStart = new Date(now.getFullYear(), 0, 1);

    const [headcount, joinersThisMonth, joinersThisYear, staff, year] = await Promise.all([
      this.db.staffProfile.count({ where: staffWhere }),
      this.db.staffProfile.count({ where: { ...staffWhere, joinedAt: { gte: monthStart } } }),
      this.db.staffProfile.count({ where: { ...staffWhere, joinedAt: { gte: yearStart } } }),
      this.db.staffProfile.findMany({
        where: staffWhere,
        include: { user: { select: { email: true, status: true } }, assignments: { select: { id: true }, take: 1 } },
        orderBy: { joinedAt: 'desc' },
      }),
      this.db.academicYear.findFirst({ where: { isCurrent: true }, select: { id: true } }),
    ]);

    // "Onboarded" is not "the form was saved" — it is "they can sign in and they teach
    // something". Anything short of that is unfinished work with a name attached.
    const needsSetup = staff
      .map((s) => {
        const noLogin = s.user.status === 'INVITED';
        const noClass = s.staffType === StaffType.TEACHER && s.assignments.length === 0;
        const reason = noLogin && noClass ? 'No login yet, and no class assigned'
          : noLogin ? 'Cannot sign in — no password set'
          : noClass ? 'No class or subject assigned'
          : null;
        return reason ? { staffId: s.id, fullName: s.fullName, email: s.user.email, reason } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return { headcount, joinersThisMonth, joinersThisYear, needsSetup, coverageGaps: year ? await this.coverageGaps(year.id, restricted) : [] };
  }

  /**
   * Every (section, subject) pair with no teacher assigned for the year — the honest answer to
   * "where do we need to hire?". A section that opts into its own subject list (electives) is
   * measured against that list; otherwise it inherits its class's catalogue.
   */
  private async coverageGaps(academicYearId: string, restricted: string | null) {
    const sections = await this.db.section.findMany({
      where: { class: restricted ? { campusId: restricted } : {} },
      include: {
        class: { select: { id: true, name: true, campusId: true } },
        subjects: { select: { subjectId: true } },
      },
    });
    if (!sections.length) return [];

    const [subjects, assignments] = await Promise.all([
      this.db.subject.findMany({ select: { id: true, name: true, classId: true } }),
      this.db.teacherAssignment.findMany({
        where: { academicYearId },
        select: { sectionId: true, subjectId: true },
      }),
    ]);
    const covered = new Set(assignments.filter((a) => a.subjectId).map((a) => `${a.sectionId}:${a.subjectId}`));
    const byId = new Map(subjects.map((s) => [s.id, s]));

    const gaps: { classId: string; className: string; sectionId: string; sectionName: string; subjectId: string; subjectName: string }[] = [];
    for (const sec of sections) {
      const own = sec.subjects.map((l) => l.subjectId);
      const taught = own.length ? own : subjects.filter((s) => s.classId === sec.class.id).map((s) => s.id);
      for (const subjectId of taught) {
        if (covered.has(`${sec.id}:${subjectId}`)) continue;
        gaps.push({
          classId: sec.class.id, className: sec.class.name,
          sectionId: sec.id, sectionName: sec.name,
          subjectId, subjectName: byId.get(subjectId)?.name ?? '—',
        });
      }
    }
    return gaps;
  }

  async getStaff(id: string) {
    const staff = await this.db.staffProfile.findFirst({
      where: { id },
      include: { user: { select: { email: true, roles: true, status: true, campusId: true } } },
    });
    if (!staff) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Staff not found');
    // Gates getStaff readers + createSalaryStructure (which calls this).
    assertCampusAccess(this.ctx.user, staff.user.campusId);
    return staff;
  }

  // ── Salary structures ────────────────────────────────────────────────────────
  async createSalaryStructure(staffId: string, dto: CreateSalaryStructureDto) {
    await this.getStaff(staffId);
    return this.db.salaryStructure.create({
      data: {
        schoolId: this.sid,
        staffId,
        basic: dto.basic,
        allowances: (dto.allowances ?? {}) as Prisma.InputJsonValue,
        fixedDeductions: (dto.deductionsFixed ?? {}) as Prisma.InputJsonValue,
        effectiveFrom: new Date(dto.effectiveFrom),
      },
    });
  }

  listSalaryStructures(staffId: string) {
    const restricted = restrictedCampusId(this.ctx.user);
    return this.db.salaryStructure.findMany({
      where: { staffId, ...(restricted ? { staff: { user: { campusId: restricted } } } : {}) },
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  // ── Teacher assignments ──────────────────────────────────────────────────────
  /**
   * An assignment has TWO campus dimensions — the teacher's, and the section's — and they are
   * not the same question. Scoping reads by the teacher's campus (as this did) hides an
   * assignment on the caller's OWN section whenever the teacher's user row carries a different
   * campus, so a campus admin sees their class as unstaffed when it is not.
   *
   * The section is what a campus admin owns (the same rule `assertClassCampus` applies to
   * classes), so reads and deletes scope by the section's campus. Creates additionally assert
   * the teacher (via `getStaff`) — inventing a cross-campus link is the dangerous direction.
   */
  private sectionCampusScope(restricted: string | null) {
    return restricted ? { section: { class: { campusId: restricted } } } : {};
  }

  /** The section a caller is about to write against must be inside their campus. */
  private async assertSectionCampus(sectionId: string): Promise<string> {
    const section = await this.db.section.findFirst({
      where: { id: sectionId },
      select: { class: { select: { campusId: true } } },
    });
    if (!section) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Section not found');
    assertCampusAccess(this.ctx.user, section.class.campusId);
    return section.class.campusId;
  }

  async createAssignment(dto: CreateTeacherAssignmentDto) {
    await this.access.assert('hr.assign');
    const staff = await this.getStaff(dto.staffId); // asserts the staff is in the caller's campus
    // ...and the section, which was unchecked: a campus-A admin could put their own teacher
    // in front of a campus-B class.
    const sectionCampusId = await this.assertSectionCampus(dto.sectionId);
    // ⚠️ Both of the above ask "may the CALLER touch this?", and an owner is school-wide, so
    // neither compared the teacher to the class. An owner could assign a campus-A teacher to a
    // campus-B section: it saved, the teacher's home told them to mark that register, and
    // attendance then refused them for being at another campus.
    assertSameCampus(staff.user.campusId, sectionCampusId, staff.fullName ?? staff.employeeCode);
    try {
      return await this.db.teacherAssignment.create({
        data: { schoolId: this.sid, staffId: dto.staffId, academicYearId: dto.academicYearId, sectionId: dto.sectionId, subjectId: dto.subjectId },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Assignment already exists');
      }
      throw e;
    }
  }

  /**
   * Assignments for a year — **the current one unless another is named**.
   *
   * This used to return every year at once, and the class screen matched a row on
   * `(sectionId, subjectId)` alone: it therefore showed last year's teacher as this year's, and
   * "replace the teacher" deleted the historical row. A teaching record is per year, so the
   * default belongs here rather than in each caller.
   *
   * Carries the teacher's name so a caller rendering "Maths · A. Khan" doesn't have to pull the
   * whole staff directory (emails, roles, campus) to resolve one label.
   */
  async listAssignments(sectionId?: string, staffId?: string, academicYearId?: string) {
    const restricted = restrictedCampusId(this.ctx.user);
    const yearId = academicYearId
      ?? (await this.db.academicYear.findFirst({ where: { isCurrent: true }, select: { id: true } }))?.id;
    // No current year set and none named ⇒ no year to report on. Returning every year instead
    // would resurrect the exact staleness this parameter exists to prevent.
    if (!yearId) return [];
    const rows = await this.db.teacherAssignment.findMany({
      where: {
        academicYearId: yearId,
        ...(sectionId ? { sectionId } : {}),
        ...(staffId ? { staffId } : {}),
        ...this.sectionCampusScope(restricted),
      },
      include: { staff: { select: { id: true, fullName: true, user: { select: { email: true } } } } },
    });
    return rows.map(({ staff, ...a }) => ({
      ...a,
      teacherName: staff.fullName ?? staff.user.email,
    }));
  }

  async deleteAssignment(id: string) {
    // Scope the delete so a campus-bound user can't remove another campus's assignment — by the
    // SECTION's campus, matching `listAssignments`. Scoping the two differently would show a row
    // that cannot then be deleted.
    const restricted = restrictedCampusId(this.ctx.user);
    const scope = this.sectionCampusScope(restricted);
    // Read first: after deleteMany the row is gone and the audit could only record an id.
    const before = await this.db.teacherAssignment.findFirst({
      where: { id, ...scope },
      select: { staffId: true, sectionId: true, subjectId: true, academicYearId: true },
    });
    const { count } = await this.db.teacherAssignment.deleteMany({ where: { id, ...scope } });
    // deleteMany is a no-op when the scope filter excludes the row — don't audit a non-event.
    if (count > 0 && before) {
      await this.audit.record({
        action: AuditActions.TEACHER_ASSIGNMENT_REMOVED,
        entityType: 'TeacherAssignment',
        entityId: id,
        oldValue: before,
      });
    }
  }
}

function defaultRoles(staffType: StaffType): Role[] {
  if (staffType === StaffType.TEACHER) return [Role.TEACHER];
  if (staffType === StaffType.ACCOUNTANT) return [Role.ACCOUNTANT];
  return [Role.STAFF];
}
