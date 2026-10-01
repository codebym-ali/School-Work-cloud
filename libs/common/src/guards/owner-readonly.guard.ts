import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppError } from '../errors/app.error';
import { ErrorCodes } from '../errors/error-codes';
import type { RequestUser } from '../context/tenant-context';
import { OWNER_WRITABLE_KEY } from '../decorators/owner-writable.decorator';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class OwnerReadOnlyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    if (!req.user) return true;

    const isOwnerOnly =
      req.user.roles.includes('OWNER_ADMIN' as any) &&
      !req.user.roles.some((r) =>
        r !== 'OWNER_ADMIN' && r !== 'PARENT' && r !== 'STUDENT',
      );

    if (!isOwnerOnly) return true;
    if (SAFE_METHODS.has(req.method)) return true;

    const writable = this.reflector.getAllAndOverride<boolean | undefined>(
      OWNER_WRITABLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (writable) return true;

    throw new AppError(
      ErrorCodes.OWNER_READ_ONLY,
      HttpStatus.FORBIDDEN,
      'Owner accounts are read-only — operational tasks are handled by the campus Ops Admin',
    );
  }
}
