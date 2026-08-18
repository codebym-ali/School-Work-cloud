import { HttpStatus, Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { AppError } from '../errors/app.error';

/**
 * Any well-formed UUID, version-agnostic (see the note below on why not v4-only).
 * Case-insensitive: Postgres renders `uuid` lowercase, but a client may echo uppercase.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Path params that name an entity: `id` and any `<entity>Id` (`campusId`, `sectionId`, …).
 * Deliberately does NOT match `token` or `provider`, the only two path params in the repo
 * that are not ids — a name-based rule is what keeps those working.
 */
const ID_PARAM = /^(id|[a-z][A-Za-z0-9]*Id)$/;

/**
 * Rejects malformed entity ids at the edge, so a bad id is a 400 rather than a 500
 * (blueprint §25.1). Registered globally via `APP_PIPE` — every `:id` route in the repo
 * is covered by construction, including routes added later.
 *
 * Before this, a non-UUID id travelled unvalidated into Prisma and surfaced as
 * `PrismaClientKnownRequestError: Inconsistent column data: Error creating UUID` — logged
 * by `AllExceptionsFilter` as an unhandled 500 and reported to Sentry. A 500 is
 * indistinguishable from a real server fault: it tells an API consumer nothing actionable
 * and it buries genuine faults in the noise.
 *
 * **Version-agnostic, not `ParseUUIDPipe`'s v4.** Every PK in the schema is
 * `@default(uuid())` (v4), so v4-only matching would look right — but `test/matrix`
 * drives most of its rows against the nil UUID `00000000-…-000000000000` as a
 * deliberately non-existent id, and the nil UUID is not v4. Rejecting it would conflate
 * *well-formed but not found* (404) with *malformed* (400), which is exactly the
 * distinction this pipe exists to draw. Format is the edge's business; existence is the
 * service's.
 *
 * Runs after the guards (Nest's order is guards → interceptors → pipes), so an unauthorised
 * caller still gets 403 and learns nothing about which ids are well-formed.
 */
@Injectable()
export class UuidParamPipe implements PipeTransform<unknown, unknown> {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const name = metadata.data;
    // Only named path params; `@Param()` with no name hands over the whole object.
    if (metadata.type !== 'param' || !name || !ID_PARAM.test(name)) return value;
    if (typeof value === 'string' && UUID.test(value)) return value;

    // The value is not echoed back — the field name is the actionable part, and a caller
    // that sent the id already has it.
    throw new AppError('VALIDATION_FAILED', HttpStatus.BAD_REQUEST, 'Malformed identifier in path', [
      { field: name, issue: 'must be a UUID' },
    ]);
  }
}
