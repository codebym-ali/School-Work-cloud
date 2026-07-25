import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '@common';
import { AdmissionsService } from './admissions.service';
import {
  AdmitDto,
  CreateInquiryDto,
  InquiryListQuery,
  RecordEntryTestDto,
  ReasonDto,
  ScheduleEntryTestDto,
} from './dto/admissions.dto';

@Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ADMISSION_CONTROLLER')
@Controller('inquiries')
export class InquiriesController {
  constructor(private readonly admissions: AdmissionsService) {}

  @Post()
  create(@Body() dto: CreateInquiryDto) {
    return this.admissions.createInquiry(dto);
  }

  @Get()
  list(@Query() q: InquiryListQuery) {
    return this.admissions.list(q);
  }

  // Must precede `:id` so "summary" isn't captured as an inquiry id.
  @Get('summary')
  summary() {
    return this.admissions.summary();
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.admissions.getOne(id);
  }

  @Post(':id/entry-test')
  schedule(@Param('id') id: string, @Body() dto: ScheduleEntryTestDto) {
    return this.admissions.scheduleEntryTest(id, dto);
  }

  @Patch(':id/entry-test')
  record(@Param('id') id: string, @Body() dto: RecordEntryTestDto) {
    return this.admissions.recordEntryTest(id, dto);
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @Body() dto: ReasonDto) {
    return this.admissions.reject(id, dto);
  }

  @Post(':id/withdraw')
  withdraw(@Param('id') id: string, @Body() dto: ReasonDto) {
    return this.admissions.withdraw(id, dto);
  }
}

// Admitting = creating a student → admission-controller-only (not owner/campus).
@Roles('ADMISSION_CONTROLLER')
@Controller('admissions')
export class AdmissionsController {
  constructor(private readonly admissions: AdmissionsService) {}

  @Post()
  admit(@Body() dto: AdmitDto) {
    return this.admissions.admit(dto);
  }
}
