import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode } from './error-codes';

export interface ErrorDetail {
  field: string;
  issue: string;
}

/**
 * Base application error carrying a stable machine `code` (blueprint §25.1).
 * The global filter renders it into the standard error envelope.
 */
export class AppError extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    status: HttpStatus,
    message: string,
    public readonly details?: ErrorDetail[],
  ) {
    super({ code, message, details }, status);
  }
}

/** 403 — tenant context missing/mismatched, or app-layer scoping violated. */
export class TenantViolationError extends AppError {
  constructor(message = 'Tenant context missing or mismatched', code: ErrorCode = 'TENANT_VIOLATION') {
    super(code, HttpStatus.FORBIDDEN, message);
  }
}
