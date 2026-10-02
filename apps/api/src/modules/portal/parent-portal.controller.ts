import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import { ENV, Roles, type Env } from '@common';
import { Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ParentPortalService } from './parent-portal.service';
import { PaymentsService } from '../fees/payments.service';
import { SwitchChildDto } from '../auth/dto/auth.dto';
import { ACTIVE_CHILD_COOKIE, setActiveChildCookie, clearActiveChildCookie } from '../auth/auth.cookies';

/**
 * Parent portal (§28). STUDENT-role; every route is read-only and resolves the caller's
 * own Student record in the service (§22.8) — no id is accepted from the client.
 *
 * The `active_child` cookie selects which child the parent is viewing when they have
 * multiple children enrolled. Every read endpoint passes it through to the service.
 */
@Roles('STUDENT')
@Controller('portal')
export class ParentPortalController {
  constructor(
    private readonly portal: ParentPortalService,
    private readonly payments: PaymentsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private activeChild(req: Request): string | null {
    return (req.cookies?.[ACTIVE_CHILD_COOKIE] as string) ?? null;
  }

  @Get('children')
  children() {
    return this.portal.children();
  }

  @Post('switch-child')
  @HttpCode(HttpStatus.OK)
  async switchChild(@Body() dto: SwitchChildDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.portal.switchChild(dto.studentId);
    setActiveChildCookie(res, this.env, dto.studentId);
    return result;
  }

  @Get('photo')
  photo(@Req() req: Request) {
    return this.portal.photo(this.activeChild(req));
  }

  @Get('overview')
  overview(@Req() req: Request) {
    return this.portal.overview(this.activeChild(req));
  }

  @Get('notifications')
  notifications(@Req() req: Request) {
    return this.portal.notifications(this.activeChild(req));
  }

  @Post('notifications/seen')
  @HttpCode(HttpStatus.OK)
  markSeen() {
    return this.portal.markNotificationsSeen();
  }

  @Get('attendance')
  attendance(@Req() req: Request) {
    return this.portal.attendance(this.activeChild(req));
  }

  @Get('attendance/summary')
  attendanceSummary(@Req() req: Request) {
    return this.portal.attendanceSummary(30, this.activeChild(req));
  }

  @Get('performance')
  performance(@Req() req: Request) {
    return this.portal.testPerformance(this.activeChild(req));
  }

  @Get('results')
  results(@Req() req: Request) {
    return this.portal.results(this.activeChild(req));
  }

  @Get('results/:termId')
  termResult(@Param('termId') termId: string, @Req() req: Request) {
    return this.portal.termResult(termId, this.activeChild(req));
  }

  @Get('results/:termId/file')
  termResultFile(@Param('termId') termId: string, @Req() req: Request) {
    return this.portal.termResultFile(termId, this.activeChild(req));
  }

  @Get('fees')
  fees(@Req() req: Request) {
    return this.portal.fees(this.activeChild(req));
  }

  @Get('fees/payments/:id/receipt')
  receipt(@Param('id') id: string) {
    return this.payments.receiptPdf(id);
  }
}
