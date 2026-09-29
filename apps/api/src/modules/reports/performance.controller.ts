import { Controller, Get, Param, Query } from '@nestjs/common';
import { Roles } from '@common';
import { PerformanceService } from './performance.service';
import { ClassPerformanceQuery, ClassStudentsQuery, StudentPerformanceQuery } from './dto/performance.dto';

/**
 * Class-test performance reporting (§11 extension) — the owner's drill-down.
 *
 * Three levels on purpose: campus → class → student. A 6,000-student school will never browse a
 * roll, so each level answers "which of these needs me?" and hands off to the next. Campus
 * scoping is FORCED in the service, so a campus admin's report can never spill another campus.
 *
 * ACCOUNTANT is excluded: this is academic performance, not money.
 */
@Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
@Controller('reports/performance')
export class PerformanceController {
  constructor(private readonly performance: PerformanceService) {}

  /** Level 1 — every class in scope, worst first. */
  @Get('classes')
  byClass(@Query() q: ClassPerformanceQuery) {
    return this.performance.byClass(q.range ?? '1m', q.campusId);
  }

  /** Level 2 — the students inside one class. */
  @Get('classes/:classId')
  byStudent(@Param('classId') classId: string, @Query() q: ClassStudentsQuery) {
    return this.performance.byStudent(classId, q.range ?? '1m', q.sectionId);
  }

  /** Level 3 — one student, by subject and by month. */
  @Get('students/:studentId')
  forStudent(@Param('studentId') studentId: string, @Query() q: StudentPerformanceQuery) {
    return this.performance.forStudent(studentId, q.range ?? '1m');
  }
}
