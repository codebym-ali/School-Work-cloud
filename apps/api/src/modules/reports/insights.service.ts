import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { paginate, TenantContext, toSkipTake, type PaginationQuery, type Paginated } from '@common';
import { TenantPrismaService } from '@database';

/** Role-shaped dashboard (blueprint §28). v1 computes the owner-view metric set. */
@Injectable()
export class DashboardService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  async get() {
    void this.ctx.requireSchoolId();
    const year = await this.db.academicYear.findFirst({ where: { isCurrent: true } });
    const enrollmentCount = year ? await this.db.studentEnrollment.count({ where: { academicYearId: year.id, status: 'ACTIVE' } }) : 0;

    const now = new Date();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const todayRecords = await this.db.attendanceRecord.findMany({ where: { date: day }, select: { status: true } });
    const present = todayRecords.filter((r) => r.status === 'PRESENT' || r.status === 'LATE' || r.status === 'HALF_DAY').length;
    const todayAttendancePercent = todayRecords.length ? Math.round((present / todayRecords.length) * 100) : null;

    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const collections = await this.db.feePayment.aggregate({ _sum: { amountPaid: true }, where: { paidAt: { gte: monthStart } } });

    const defaulters = await this.db.feeInvoice.findMany({ where: { status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] }, dueDate: { lt: now } }, select: { studentId: true }, distinct: ['studentId'] });
    const [pendingStudentLeaves, pendingStaffLeaves, failedSms] = await Promise.all([
      this.db.studentLeave.count({ where: { status: 'PENDING' } }),
      this.db.staffLeave.count({ where: { status: 'PENDING' } }),
      this.db.smsLog.count({ where: { status: 'FAILED' } }),
    ]);

    return {
      enrollmentCount,
      todayAttendancePercent,
      monthCollections: Number(collections._sum.amountPaid ?? 0),
      defaulterCount: defaulters.length,
      pendingLeaves: pendingStudentLeaves + pendingStaffLeaves,
      failedSmsCount: failedSms,
    };
  }
}

export class AuditLogQuery implements PaginationQuery {
  page = 1;
  pageSize = 25;
  sort?: string;
  from?: string;
  to?: string;
  action?: string;
  userId?: string;
  entityType?: string;
  entityId?: string;
}

/** Audit-log browser (blueprint §24). */
@Injectable()
export class AuditQueryService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  async list(q: AuditLogQuery): Promise<Paginated<unknown>> {
    const where: Prisma.AuditLogWhereInput = {};
    if (q.action) where.action = q.action;
    if (q.userId) where.userId = q.userId;
    if (q.entityType) where.entityType = q.entityType;
    if (q.entityId) where.entityId = q.entityId;
    if (q.from || q.to) where.createdAt = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) };
    const { skip, take } = toSkipTake(q);
    const [rows, total] = await Promise.all([
      this.db.auditLog.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.db.auditLog.count({ where }),
    ]);
    return paginate(rows, total, q);
  }
}
