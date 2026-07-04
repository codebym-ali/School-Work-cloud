import { SetMetadata } from '@nestjs/common';

/** Marks a route as public — skips JwtAuthGuard (blueprint §19 public route list). */
export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);
