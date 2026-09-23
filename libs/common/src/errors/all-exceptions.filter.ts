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
import { Prisma } from '@prisma/client';
import { AppError, type ErrorDetail } from './app.error';
import { ErrorCodes, type ErrorCode } from './error-codes';
import { captureError } from '../observability/sentry';
import { CLS_KEYS, type RequestUser } from '../context/tenant-context';

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
      const err = exception as Error;
      this.logger.error(
        `Unhandled error on ${req.method} ${req.url} [${requestId}]: ${err?.stack ?? String(exception)}`,
      );
      // Report to Sentry with tenant/request context (§31). No-op without SENTRY_DSN.
      const user = this.cls?.get?.(CLS_KEYS.user) as RequestUser | undefined;
      captureError(exception, {
        requestId,
        schoolId: this.cls?.get?.(CLS_KEYS.schoolId) ?? user?.schoolId,
        userId: user?.userId,
        method: req.method,
        url: req.url,
      });
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

    const prisma = this.normalizePrisma(exception, requestId);
    if (prisma) return prisma;

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: { code: ErrorCodes.INTERNAL, message: 'Internal server error', requestId } },
    };
  }

  /**
   * Safety net for database errors that escaped a service-level pre-check (§WS-A). A stray `P2002`,
   * `P2003`, `P2025` or a Postgres CHECK/FK violation must degrade to a clean 4xx — never a 500 with a
   * stack leak. Services should still throw a human-worded 409/404/422 first (that wins because it
   * throws before Prisma does); this is the floor, with a generic message that names no internals.
   */
  private normalizePrisma(exception: unknown, requestId?: string): { status: number; body: ErrorBody } | null {
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002': {
          // Unique constraint. `meta.target` names the column(s); surfaced as a field, never the raw value.
          const target = exception.meta?.target;
          const fields = Array.isArray(target) ? target : target ? [String(target)] : [];
          return {
            status: HttpStatus.CONFLICT,
            body: {
              error: {
                code: ErrorCodes.CONFLICT,
                message: 'A record with these details already exists.',
                details: fields.length ? fields.map((f) => ({ field: String(f), issue: 'must be unique' })) : undefined,
                requestId,
              },
            },
          };
        }
        case 'P2025':
          return {
            status: HttpStatus.NOT_FOUND,
            body: { error: { code: ErrorCodes.NOT_FOUND, message: 'The requested record was not found.', requestId } },
          };
        case 'P2003':
          return {
            status: HttpStatus.CONFLICT,
            body: {
              error: { code: ErrorCodes.CONFLICT, message: 'This record is still referenced by other data.', requestId },
            },
          };
        case 'P2010': {
          // Raw-query failure — carries the Postgres SQLSTATE in meta.code (23514 CHECK, 23503 FK).
          const sqlState = (exception.meta as { code?: string } | undefined)?.code;
          if (sqlState === '23514' || sqlState === '23503') {
            return {
              status: HttpStatus.UNPROCESSABLE_ENTITY,
              body: { error: { code: ErrorCodes.VALIDATION_FAILED, message: 'The data violates a database rule.', requestId } },
            };
          }
          return null;
        }
        default:
          return null;
      }
    }
    return null;
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
