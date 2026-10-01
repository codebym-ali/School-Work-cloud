import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { OwnerWritable, RequiresMfa, Roles } from '@common';
import { UsersService } from './users.service';
import { AccessService } from '../access/access.service';
import { BulkDeleteUsersDto, CreateUserDto, ResetUserPasswordDto, SetAccessDto, SetModuleAccessDto, UpdateUserDto } from './dto/users.dto';

/**
 * Users & roles (blueprint §23). OWNER_ADMIN has full control; CAMPUS_ADMIN may create,
 * read, and reset-password for users within their own campus (lower roles only — e.g. the
 * admission controller) — the service enforces the campus and role limits (§22.8).
 * Update (role/status change) stays OWNER_ADMIN-only.
 */
@OwnerWritable()
@Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly access: AccessService,
  ) {}

  @Get()
  list() {
    return this.users.list();
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  // Owner-only bulk remove. Static path — declared before the `:id` routes so it isn't shadowed.
  @Roles('OWNER_ADMIN')
  @RequiresMfa()
  @Post('bulk-delete')
  bulkDelete(@Body() dto: BulkDeleteUsersDto) {
    return this.users.removeMany(dto.ids);
  }

  // Ops Admin may change lower staff's roles/status too; the service grant-ceiling forbids it from
  // touching an owner or another ops admin, or granting its own level or above.
  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN')
  @RequiresMfa()
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }

  // Owner removes a user (soft-delete → gone from the directory, login blocked).
  @Roles('OWNER_ADMIN')
  @RequiresMfa()
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.users.remove(id);
  }

  @RequiresMfa()
  @Post(':id/reset-password')
  resetPassword(@Param('id') id: string, @Body() dto: ResetUserPasswordDto) {
    return this.users.resetPassword(id, dto.password);
  }

  // Toggle an access capability on an existing employee (reuses the account — no duplicate login).
  // Owner + Ops Admin; the service grant-ceiling forbids Ops from granting OPERATIONS_ADMIN/OWNER_ADMIN
  // or toggling one on an owner/another ops admin. Granting OPERATIONS_ADMIN is therefore owner-only.
  @Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN')
  @RequiresMfa()
  @Patch(':id/access')
  setAccess(@Param('id') id: string, @Body() dto: SetAccessDto) {
    return this.users.setAccess(id, dto.role, dto.grant);
  }

  // Owner controls individual module (functionality) access for a user's granted roles.
  @Roles('OWNER_ADMIN')
  @Get(':id/modules')
  listModules(@Param('id') id: string) {
    return this.access.listForUser(id);
  }

  @Roles('OWNER_ADMIN')
  @RequiresMfa()
  @Patch(':id/modules')
  setModule(@Param('id') id: string, @Body() dto: SetModuleAccessDto) {
    return this.access.setModule(id, dto.moduleKey, dto.allowed);
  }
}
