import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { PERFORMANCE_RANGES, type PerformanceRange } from '@common';

export class StudentPerformanceQuery {
  /** Shared vocabulary with the student portal, so the two never diverge. */
  @IsOptional() @IsIn(PERFORMANCE_RANGES as unknown as string[])
  range?: PerformanceRange;
}

export class ClassPerformanceQuery extends StudentPerformanceQuery {
  /** Ignored for a campus-bound admin — their own campus is forced in the service. */
  @IsOptional() @IsUUID()
  campusId?: string;
}
