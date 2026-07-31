import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { Roles } from '@common';
import { UsersService } from './users.service';
import { SetAdmissionOfficerDto } from './dto/users.dto';

/**
 * The per-campus admission seat (blueprint §8/§23).
 *
 * A campus has exactly ONE admission officer, so the thing being managed is the campus's
 * seat — not a capability on a person. That is why these routes are keyed by campus and why
 * a change of holder is a single PUT: handing the seat over as revoke-then-grant from the
 * client is two requests that can half-fail, and the partial unique index would reject the
 * grant while the outgoing holder still held it.
 *
 * Reads are campus-scoped in the service (a campus admin sees only their own campus); the
 * writes are OWNER_ADMIN-only, because the seat says who speaks for a campus's admissions.
 */
@Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
@Controller('admission-officers')
export class AdmissionOfficersController {
  constructor(private readonly users: UsersService) {}

  /** Every campus with its current admission officer (or none) — the overview screen. */
  @Get()
  list() {
    return this.users.listAdmissionOfficers();
  }

  /** Assign the seat, or hand it over to someone else on the same campus. */
  @Roles('OWNER_ADMIN')
  @Put(':campusId')
  set(@Param('campusId', ParseUUIDPipe) campusId: string, @Body() dto: SetAdmissionOfficerDto) {
    return this.users.setAdmissionOfficer(campusId, dto.userId);
  }

  /** Vacate the seat. The person keeps their login and every other role. */
  @Roles('OWNER_ADMIN')
  @Delete(':campusId')
  remove(@Param('campusId', ParseUUIDPipe) campusId: string) {
    return this.users.removeAdmissionOfficer(campusId);
  }
}
