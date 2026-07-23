import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isAdminRole, paginate, restrictedCampusId, TenantContext, toSkipTake, type PaginationQuery, type Paginated } from '@common';
import { TenantPrismaService } from '@database';

/** Financial metrics — the set an ACCOUNTANT sees. */
const FINANCIAL_METRICS = ['enrollmentCount', 'monthCollections', 'defaulterCount'] as const;
/** Everything — OWNER_ADMIN / CAMPUS_ADMIN. */
const ALL_METRICS = [...FINANCIAL_METRICS, 'todayAttendancePercent', 'pendingLeaves', 'failedSmsCount'] as const;

/**
 * Role-shaped dashboard (blueprint §28, §22.8). Two shapings:
 *  - **campus scope**: a campus-bound admin's student-centric metrics (enrolment, attendance,
 *    collections, defaulters, student leaves) count ONLY their campus — deny-by-default (P1.7).
 *    Staff leaves and failed SMS have no campus dimension, so they stay school-wide.
 *  - **role selection**: an ACCOUNTANT sees the financial metrics only; the ops metrics
 *    (attendance/leaves/failed SMS) are neither computed nor returned. `visible` tells the
 *    UI which cards to render.
 */
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
    const restricted = restrictedCampusId(this.ctx.user); // null for OWNER_ADMIN
    const isAdmin = isAdminRole(this.ctx.user); // OWNER_ADMIN or CAMPUS_ADMIN
    const visible = isAdmin ? ALL_METRICS : FINANCIAL_METRICS;

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const year = await this.db.academicYear.findFirst({ where: { isCurrent: true } });
    const enrollmentCount = year
      ? await this.db.studentEnrollment.count({ where: { academicYearId: year.id, status: 'ACTIVE', student: { deletedAt: null }, ...(restricted ? { campusId: restricted } : {}) } })
      : 0;

    const collections = await this.db.feePayment.aggregate({
      _sum: { amountPaid: true },
      where: { paidAt: { gte: monthStart }, ...(restricted ? { invoice: { enrollment: { campusId: restricted } } } : {}) },
    });

    const defaulters = await this.db.feeInvoice.findMany({
      where: { status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] }, dueDate: { lt: now }, ...(restricted ? { enrollment: { campusId: restricted } } : {}) },
      select: { studentId: true },
      distinct: ['studentId'],
    });

    // Ops metrics: admins only (an ACCOUNTANT neither sees nor triggers these queries).
    let todayAttendancePercent: number | null = null;
    let pendingLeaves: number | null = null;
    let failedSmsCount: number | null = null;
    if (isAdmin) {
      const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const todayRecords = await this.db.attendanceRecord.findMany({
        where: { date: day, ...(restricted ? { enrollment: { campusId: restricted } } : {}) },
        select: { status: true },
      });
      const present = todayRecords.filter((r) => r.status === 'PRESENT' || r.status === 'LATE' || r.status === 'HALF_DAY').length;
      todayAttendancePercent = todayRecords.length ? Math.round((present / todayRecords.length) * 100) : null;

      const [studentLeaves, staffLeaves, failedSms] = await Promise.all([
        this.db.studentLeave.count({ where: { status: 'PENDING', ...(restricted ? { student: { enrollments: { some: { status: 'ACTIVE', campusId: restricted } } } } : {}) } }),
        this.db.staffLeave.count({ where: { status: 'PENDING' } }), // staff have no campus dimension
        this.db.smsLog.count({ where: { status: 'FAILED' } }), // school-wide
      ]);
      pendingLeaves = studentLeaves + staffLeaves;
      failedSmsCount = failedSms;
    }

    return {
      enrollmentCount,
      todayAttendancePercent,
      monthCollections: Number(collections._sum.amountPaid ?? 0),
      defaulterCount: defaulters.length,
      pendingLeaves,
      failedSmsCount,
      visible: [...visible],
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
