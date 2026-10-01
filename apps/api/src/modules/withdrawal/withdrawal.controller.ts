import { Body, Controller, Param, Post } from '@nestjs/common';
import { IsBoolean, IsDateString, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { OwnerWritable, Roles } from '@common';
import { WithdrawalService } from './withdrawal.service';

class WithdrawDto {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
  @IsOptional() @IsBoolean() overrideFeeClearance?: boolean;
  /**
   * The day the student left, as the office records it (YYYY-MM-DD). Omitted means today. Like the
   * admission date, it is an office fact rather than a timestamp: a family often gives notice and the
   * paperwork is done days later. It decides which already-raised invoices are for months after leaving.
   */
  @IsOptional() @IsDateString() leavingDate?: string;
}

@OwnerWritable()
@Controller('students')
export class WithdrawalController {
  constructor(private readonly withdrawal: WithdrawalService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post(':id/withdraw')
  withdraw(@Param('id') id: string, @Body() dto: WithdrawDto) {
    return this.withdrawal.withdraw(id, dto);
  }
}
