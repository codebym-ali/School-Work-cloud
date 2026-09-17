import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  isAdminRole,
  restrictedCampusId,
  TenantContext,
  KeysetQuery,
  type KeysetPage,
  decodeKeysetCursor,
  keysetOlderThan,
  toKeysetPage,
  KEYSET_ORDER,
} from '@common';
import { TenantPrismaService } from '@database';

/** Today's register, by what actually happened — the shape the dashboard chart plots. */
export interface AttendanceBreakdown {
  present: number; late: number; leave: number; absent: number; unmarked: number;
}
/** One bar of the collections trend. `month` is `YYYY-MM`, so it sorts as a string. */
export interface CollectionPoint { month: string; collected: number; }

/** How many months of history the trend carries. Six fits a phone without scrolling and is
 *  long enough to show a fee cycle; twelve would be a report, not a dashboard. */
const TREND_MONTHS = 6;

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

    // ── Collections trend ─────────────────────────────────────────────────────────────────
    // A single month's total answers "how much", never "is this normal" — and "is this normal"
    // is the only question a headline number on a dashboard can usefully raise. Six months of
    // context turns Rs 90,000 from a fact into a judgement.
    //
    // ⚠️ Bucketed in JS from one ranged query rather than six queries or a raw `date_trunc`:
    // six round trips for six numbers is wasteful, and raw SQL here would bypass the Prisma
    // extension that scopes every read to the tenant — the one thing that must never be
    // hand-rolled in this codebase.
    const trendStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (TREND_MONTHS - 1), 1));
    const trendPayments = await this.db.feePayment.findMany({
      where: { paidAt: { gte: trendStart }, ...(restricted ? { invoice: { enrollment: { campusId: restricted } } } : {}) },
      select: { paidAt: true, amountPaid: true },
    });
    const buckets = new Map<string, number>();
    for (let i = 0; i < TREND_MONTHS; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (TREND_MONTHS - 1 - i), 1));
      // Every month gets a key up front, so a month with no payments plots as a real zero
      // instead of vanishing and silently shortening the axis.
      buckets.set(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, 0);
    }
    for (const pmt of trendPayments) {
      const k = `${pmt.paidAt.getUTCFullYear()}-${String(pmt.paidAt.getUTCMonth() + 1).padStart(2, '0')}`;
      if (buckets.has(k)) buckets.set(k, (buckets.get(k) ?? 0) + Number(pmt.amountPaid));
    }
    const collectionsTrend: CollectionPoint[] = [...buckets].map(([month, collected]) => ({ month, collected }));

    const defaulters = await this.db.feeInvoice.findMany({
      where: { status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] }, dueDate: { lt: now }, ...(restricted ? { enrollment: { campusId: restricted } } : {}) },
      select: { studentId: true },
      distinct: ['studentId'],
    });

    // Ops metrics: admins only (an ACCOUNTANT neither sees nor triggers these queries).
    let attendanceBreakdown: AttendanceBreakdown | null = null;
    let todayAttendancePercent: number | null = null;
    let todayAttendanceMarked: number | null = null;
    let todayAttendanceExpected: number | null = null;
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

      // ⚠️ That percentage is over the records that EXIST, so on its own it is a reassuring lie:
      // one section of twenty marked, everyone present ⇒ "100%". The staff register learned this
      // rule the hard way — a percentage over a half-kept register is not a fact about the school.
      //
      // So the coverage travels WITH it and is displayed beside it, never folded into it. Folding
      // would produce a different lie (a school that has marked half its registers is not "50%
      // attendance"), and hiding it leaves the reassuring one.
      const expectedToday = await this.db.studentEnrollment.count({
        where: {
          status: 'ACTIVE',
          student: { deletedAt: null },
          startedAt: { lte: day },
          ...(restricted ? { campusId: restricted } : {}),
        },
      });
      todayAttendanceMarked = todayRecords.length;
      todayAttendanceExpected = expectedToday;

      // ⚠️ **The breakdown was already in memory and was being thrown away.** `todayRecords` is
      // fetched WITH `status` purely to compute the percentage above, and every status was then
      // discarded — so the dashboard could say "100%" but could not say what the day was actually
      // made of. Counting them here adds no query.
      //
      // HALF_DAY rides with PRESENT for the same reason it does in the percentage: the child was
      // at school. Splitting it into its own band would make the chart disagree with the number
      // printed beside it, and two true-looking figures that contradict each other are worse than
      // one coarse one.
      attendanceBreakdown = {
        present: todayRecords.filter((r) => r.status === 'PRESENT' || r.status === 'HALF_DAY').length,
        late: todayRecords.filter((r) => r.status === 'LATE').length,
        leave: todayRecords.filter((r) => r.status === 'ON_LEAVE').length,
        absent: todayRecords.filter((r) => r.status === 'ABSENT').length,
        // Not a status: the registers nobody has marked yet. It is the honest remainder, and it
        // is what stops a part-to-whole chart implying the whole school has been accounted for.
        unmarked: Math.max(0, expectedToday - todayRecords.length),
      };

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
      todayAttendanceMarked,
      todayAttendanceExpected,
      monthCollections: Number(collections._sum.amountPaid ?? 0),
      defaulterCount: defaulters.length,
      pendingLeaves,
      failedSmsCount,
      // Financial, so an ACCOUNTANT gets it: it is the same money as `monthCollections`, only
      // with its history attached.
      collectionsTrend,
      // Ops, so it is null for an accountant — same gate as the percentage it breaks down.
      attendanceBreakdown,
      visible: [...visible],
    };
  }
}

export class AuditLogQuery extends KeysetQuery {
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
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  /**
   * The activity log: who did what, when, and why (GAP-06).
   *
   * ⚠️ **Campus-scoped, by the ACTOR.** CAMPUS_ADMIN may read this route, and until 2026-09-16 nothing
   * narrowed it — a campus-A admin read the whole school's log, including campus-B reversals, withdrawals,
   * reasons and before/after values that carry guardians' phone numbers. An audit row has no campus of its
   * own, so a campus-bound reader sees the entries recorded by people on THEIR campus. Those people can only
   * act on that campus, so nothing from another campus appears. Entries by school-wide staff (the owner, the
   * deputy) are the owner's log, not a campus admin's.
   *
   * ⚠️ **Keyset-paged, no `count()`** — see `keyset.ts`. Offset paging on a table that only grows is both
   * slower every month and wrong: new entries shift every page while someone is reading.
   */
  async list(q: AuditLogQuery): Promise<KeysetPage<unknown>> {
    const where: Prisma.AuditLogWhereInput = {};
    if (q.action) where.action = q.action;
    if (q.userId) where.userId = q.userId;
    if (q.entityType) where.entityType = q.entityType;
    if (q.entityId) where.entityId = q.entityId;
    if (q.from || q.to) where.createdAt = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) };

    const restricted = restrictedCampusId(this.ctx.user);
    if (restricted !== null) where.user = { campusId: restricted };

    const limit = q.limit ?? 50;
    const rows = await this.db.auditLog.findMany({
      where: { AND: [where, keysetOlderThan(decodeKeysetCursor(q.cursor))] },
      orderBy: KEYSET_ORDER,
      take: limit + 1,
      include: { user: { select: { email: true } } },
    });
    const page = toKeysetPage(rows, limit);
    return {
      nextCursor: page.nextCursor,
      // The actor's address, not their id: a raw user id means nothing to the person reading the log.
      data: page.data.map(({ user, ...r }) => ({ ...r, actor: user?.email ?? null })),
    };
  }
}
