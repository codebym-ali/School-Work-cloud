import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Shared list query params (blueprint §25.2): 1-based page, pageSize (max 100),
 * and an allowlisted `sort` string ("field:asc|desc"). Endpoints validate the
 * sort field against their own allowlist.
 */
export class PaginationQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 25;

  @IsOptional()
  @IsString()
  sort?: string; // "field:asc" | "field:desc"
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function paginate<T>(data: T[], total: number, q: PaginationQuery): Paginated<T> {
  return { data, total, page: q.page, pageSize: q.pageSize };
}

/** Prisma skip/take from a PaginationQuery. */
export function toSkipTake(q: PaginationQuery): { skip: number; take: number } {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}

/**
 * Parse "field:dir" into a Prisma orderBy, rejecting fields not in `allowlist`.
 * Returns undefined when no sort is given.
 */
export function parseSort(
  sort: string | undefined,
  allowlist: readonly string[],
  fallback?: Record<string, 'asc' | 'desc'>,
): Record<string, 'asc' | 'desc'> | undefined {
  if (!sort) return fallback;
  const [field, dirRaw] = sort.split(':');
  const dir = dirRaw === 'desc' ? 'desc' : 'asc';
  if (!allowlist.includes(field)) return fallback;
  return { [field]: dir };
}
