import { HttpStatus } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { AppError } from '../errors/app.error';
import { ErrorCodes } from '../errors/error-codes';

/**
 * Keyset ("cursor") pagination for append-only data, newest first (plan foundation F3).
 *
 * ⚠️ **Why not `skip`/`take`, and why it is correctness, not just speed.** On a table that only ever
 * grows — the audit log — `OFFSET k` makes Postgres read and discard k rows, so page 40 costs forty
 * pages. Worse, the order is `createdAt DESC`: every entry written while someone is paging shifts all
 * later pages down by one, so they see a row twice, or never. A keyset asks "the rows strictly OLDER than
 * the last one I saw", which an index answers directly and which new rows cannot disturb.
 *
 * ⚠️ **`createdAt` alone is not a total order** — two rows written in the same millisecond tie, and a
 * cursor on `createdAt` alone would skip whichever came second. The `id` tiebreak makes the order total,
 * so every row sits at exactly one position.
 *
 * The cursor is opaque base64url JSON. Callers pass back what they were given; they never build one.
 */
export interface KeysetCursor {
  at: string;
  id: string;
}

export class KeysetQuery {
  @IsOptional() @IsString()
  cursor?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit = 50;
}

export interface KeysetPage<T> {
  data: T[];
  /** Null when there is nothing older. */
  nextCursor: string | null;
}

export function encodeKeysetCursor(c: KeysetCursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

/** Decode a client-supplied cursor. A malformed one is a 400, never an unfiltered first page. */
export function decodeKeysetCursor(raw: string | undefined): KeysetCursor | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.BAD_REQUEST, 'Invalid cursor');
  }
  const c = parsed as Partial<KeysetCursor>;
  if (typeof c?.at !== 'string' || typeof c?.id !== 'string' || Number.isNaN(Date.parse(c.at))) {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.BAD_REQUEST, 'Invalid cursor');
  }
  return { at: c.at, id: c.id };
}

/**
 * The Prisma `where` fragment for "strictly after this cursor" in `createdAt DESC, id DESC` order.
 * Pair it with exactly that `orderBy`, or the two disagree about what "after" means.
 */
export function keysetOlderThan(c: KeysetCursor | null) {
  if (!c) return {};
  const at = new Date(c.at);
  return { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: c.id } }] };
}

export const KEYSET_ORDER = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

/**
 * Trim a result fetched with `take: limit + 1` into a page. The extra row is how "is there more?" is
 * answered without a `count()` — which on an append-only table is the other half of the cost offset
 * paging pays on every request.
 */
export function toKeysetPage<T extends { id: string; createdAt: Date }>(rows: T[], limit: number): KeysetPage<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return { data, nextCursor: hasMore && last ? encodeKeysetCursor({ at: last.createdAt.toISOString(), id: last.id }) : null };
}
