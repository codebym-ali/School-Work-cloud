import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { OwnerWritable, Roles } from '@common';
import { ApprovalsService } from './approvals.service';

class ApprovalListQueryDto {
  @IsOptional() @IsIn(['PENDING', 'APPROVED', 'REJECTED']) status?: 'PENDING' | 'APPROVED' | 'REJECTED';
  @IsOptional() @IsIn(['VOUCHER_BATCH', 'SETUP_CHANGE']) type?: 'VOUCHER_BATCH' | 'SETUP_CHANGE';
}
class ApproveDto {
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
class RejectDto {
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}

/**
 * The owner's Approvals inbox. Owner decides; the office (Ops Admin, accountant) can see the requests they raised —
 * campus-scoped, so a campus's Ops Admin never sees another campus's requests.
 */
@OwnerWritable()
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Roles('OWNER_ADMIN', 'ACCOUNTANT')
  @Get()
  list(@Query() q: ApprovalListQueryDto) {
    return this.approvals.list(q);
  }

  /** Powers the dashboard / sidebar chip. Declared before `:id` so it is never read as an id. */
  @Roles('OWNER_ADMIN', 'ACCOUNTANT')
  @Get('pending-count')
  pendingCount() {
    return this.approvals.pendingCount().then((pending) => ({ pending }));
  }

  @Roles('OWNER_ADMIN', 'ACCOUNTANT')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.approvals.get(id);
  }

  /** Owner only: approving issues the held vouchers to families. */
  @Roles('OWNER_ADMIN')
  @Post(':id/approve')
  approve(@Param('id') id: string, @Body() dto: ApproveDto) {
    return this.approvals.approve(id, dto.note);
  }

  @Roles('OWNER_ADMIN')
  @Post(':id/reject')
  reject(@Param('id') id: string, @Body() dto: RejectDto) {
    return this.approvals.reject(id, dto.reason);
  }
}
