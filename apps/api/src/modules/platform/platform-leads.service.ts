import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppError, ErrorCodes, paginate, toSkipTake, type Paginated } from '@common';
import { PlatformPrismaService } from '@database';
import { PlatformAuditService } from './platform-audit.service';
import type { PlatformActionContext } from './platform.service';
import type { ListLeadsQuery } from './dto/platform.dto';

type LeadStatus = 'NEW' | 'CONTACTED' | 'CONVERTED' | 'CLOSED';

/** A demo/contact request as the console lists it (SA8). */
export interface LeadSummary {
  id: string;
  name: string;
  schoolName: string | null;
  email: string;
  phone: string | null;
  studentCount: number | null;
  message: string | null;
  status: LeadStatus;
  source: string;
  note: string | null;
  handledById: string | null;
  handledAt: Date | null;
  createdAt: Date;
}

export interface NewLead {
  name: string;
  email: string;
  schoolName?: string;
  phone?: string;
  studentCount?: number;
  message?: string;
}

/**
 * Sales leads (SA8) — demo/contact requests from the public marketing site, worked from the console.
 * Runs on the platform_admin (BYPASSRLS) connection; `platform_leads` is a NON-tenant table holding
 * prospect PII. Capture is public + unauthenticated (anyone can submit the form); reading and working
 * leads is confined to SUPER_ADMIN / SUPPORT by the controller.
 */
@Injectable()
export class PlatformLeadsService {
  constructor(
    private readonly platform: PlatformPrismaService,
    private readonly audit: PlatformAuditService,
  ) {}

  private toSummary(l: {
    id: string; name: string; schoolName: string | null; email: string; phone: string | null;
    studentCount: number | null; message: string | null; status: LeadStatus; source: string;
    note: string | null; handledById: string | null; handledAt: Date | null; createdAt: Date;
  }): LeadSummary {
    return {
      id: l.id, name: l.name, schoolName: l.schoolName, email: l.email, phone: l.phone,
      studentCount: l.studentCount, message: l.message, status: l.status, source: l.source,
      note: l.note, handledById: l.handledById, handledAt: l.handledAt, createdAt: l.createdAt,
    };
  }

  /** Capture a demo/contact request from the public marketing site (SA8). No auth — anyone may submit. */
  async createLead(input: NewLead): Promise<{ ok: true }> {
    await this.platform.platformLead.create({
      data: {
        name: input.name,
        email: input.email,
        schoolName: input.schoolName ?? null,
        phone: input.phone ?? null,
        studentCount: input.studentCount ?? null,
        message: input.message ?? null,
      },
    });
    return { ok: true };
  }

  /** The console leads inbox (SA8), newest first, filterable by pipeline status. */
  async listLeads(q: ListLeadsQuery): Promise<Paginated<LeadSummary>> {
    const where: Prisma.PlatformLeadWhereInput = q.status ? { status: q.status as LeadStatus } : {};
    const { skip, take } = toSkipTake(q);
    const [rows, total] = await Promise.all([
      this.platform.platformLead.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip, take }),
      this.platform.platformLead.count({ where }),
    ]);
    return paginate(rows.map((r) => this.toSummary(r)), total, q);
  }

  /** Advance a lead / add an internal note (SA8). Stamps who handled it; audited `LEAD_UPDATE`. */
  async updateLead(id: string, input: { status?: string; note?: string }, ctx: PlatformActionContext): Promise<LeadSummary> {
    const lead = await this.platform.platformLead.findUnique({ where: { id } });
    if (!lead) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Lead not found');
    const updated = await this.platform.platformLead.update({
      where: { id },
      data: {
        ...(input.status ? { status: input.status as LeadStatus } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        handledById: ctx.platformUserId,
        handledAt: new Date(),
      },
    });
    await this.audit.record({
      platformUserId: ctx.platformUserId,
      action: 'LEAD_UPDATE',
      metadata: { leadId: id, status: input.status ?? lead.status },
      ip: ctx.ip,
    });
    return this.toSummary(updated);
  }
}
