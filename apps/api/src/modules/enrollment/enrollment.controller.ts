import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { Roles } from '@common';
import { EnrollmentService } from './enrollment.service';
import { PromotionService } from './promotion.service';
import { EnrollmentListQuery, TransferDto } from './dto/enrollment.dto';
import { PromoteDto } from './dto/promotion.dto';

@Controller('enrollments')
export class EnrollmentController {
  constructor(private readonly enrollment: EnrollmentService) {}

  /**
   * ⚠️ **This had NO `@Roles` at all** until 2026-08-11, so every authenticated session — student,
   * parent, any staff member — could enumerate which child is in which class across the school. It
   * was found by *adding the permission-matrix row*, which is the argument for the matrix: the
   * write beside it was correctly gated, and a guarded write does not imply a guarded read.
   *
   * TEACHER is admitted because the attendance roster and marks entry both load from here. The
   * campus half is narrowed in the service.
   */
  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER', 'TEACHER')
  @Get()
  list(@Query() q: EnrollmentListQuery) {
    return this.enrollment.list(q);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post('transfer')
  transfer(@Body() dto: TransferDto) {
    return this.enrollment.transfer(dto);
  }
}

@Controller('promotions')
export class PromotionController {
  constructor(private readonly promotion: PromotionService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post()
  @HttpCode(HttpStatus.OK)
  promote(@Body() dto: PromoteDto) {
    return this.promotion.promote(dto);
  }
}
