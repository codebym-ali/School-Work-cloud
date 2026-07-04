import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { RequestUser } from '../context/tenant-context';

/** Injects the authenticated principal attached by JwtAuthGuard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestUser | undefined => {
    const req = ctx.switchToHttp().getRequest<{ user?: RequestUser }>();
    return req.user;
  },
);
