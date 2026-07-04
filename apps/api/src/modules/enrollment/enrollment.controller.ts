import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Roles } from '@common';
import { EnrollmentService } from './enrollment.service';
import { EnrollmentListQuery, TransferDto } from './dto/enrollment.dto';

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
