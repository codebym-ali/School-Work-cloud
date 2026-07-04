import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { AppError, type ErrorDetail } from './app.error';
import { ErrorCodes, type ErrorCode } from './error-codes';

interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
    requestId?: string;
  };
}

/**
 * Renders every failure into the single error envelope (blueprint §25.1):
 *   { error: { code, message, details?, requestId } }
 * Never leaks internals: unknown errors become 500 INTERNAL with a generic message,
 * and the real cause is logged with the requestId for correlation.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly cls: ClsService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = this.cls?.getId?.() ?? (req as { id?: string }).id;

    const { status, body } = this.normalize(exception, requestId);

    if (status >= 500) {
      this.logger.error(
        { requestId, path: req.url, err: exception },
        'Unhandled error',
      );
    }
    res.status(status).json(body);
  }

  private normalize(exception: unknown, requestId?: string): { status: number; body: ErrorBody } {
    if (exception instanceof AppError) {
      return {
        status: exception.getStatus(),
        body: { error: { code: exception.code, message: exception.message, details: exception.details, requestId } },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const resp = exception.getResponse();
      const message =
        typeof resp === 'string'
          ? resp
          : ((resp as { message?: string | string[] }).message ?? exception.message);
      // class-validator ValidationPipe emits an array of messages -> map to details.
      const details = Array.isArray((resp as { message?: unknown }).message)
        ? ((resp as { message: string[] }).message).map((m) => ({ field: '', issue: m }))
        : undefined;
      return {
        status,
        body: {
          error: {
            code: this.statusToCode(status),
            message: Array.isArray(message) ? 'Validation failed' : String(message),
            details,
            requestId,
          },
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: { code: ErrorCodes.INTERNAL, message: 'Internal server error', requestId } },
    };
  }

  private statusToCode(status: number): ErrorCode {
    switch (status) {
      case 400:
        return ErrorCodes.VALIDATION_FAILED;
      case 401:
        return ErrorCodes.UNAUTHENTICATED;
      case 403:
        return ErrorCodes.FORBIDDEN;
      case 404:
        return ErrorCodes.NOT_FOUND;
      case 409:
        return ErrorCodes.CONFLICT;
      case 422:
        return ErrorCodes.VALIDATION_FAILED;
      case 429:
        return ErrorCodes.RATE_LIMITED;
      default:
        return ErrorCodes.INTERNAL;
    }
  }
}
