import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { Roles } from '@common';
import { EnrollmentService } from './enrollment.service';
import { PromotionService } from './promotion.service';
import { EnrollmentListQuery, TransferDto } from './dto/enrollment.dto';
import { PromoteDto } from './dto/promotion.dto';

@Controller('enrollments')
export class EnrollmentController {
  constructor(private readonly enrollment: EnrollmentService) {}

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
