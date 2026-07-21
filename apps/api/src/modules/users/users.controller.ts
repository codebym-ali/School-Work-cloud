import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { Roles } from '@common';
import { UsersService } from './users.service';
import { BulkDeleteUsersDto, CreateUserDto, GrantAccessDto, ResetUserPasswordDto, UpdateUserDto } from './dto/users.dto';

/**
 * Users & roles (blueprint §23). OWNER_ADMIN has full control; CAMPUS_ADMIN may create,
 * read, and reset-password for users within their own campus (lower roles only — e.g. the
 * admission controller) — the service enforces the campus and role limits (§22.8).
 * Update (role/status change) stays OWNER_ADMIN-only.
 */
@Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

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
  @Post('bulk-delete')
  bulkDelete(@Body() dto: BulkDeleteUsersDto) {
    return this.users.removeMany(dto.ids);
  }

  @Roles('OWNER_ADMIN')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }

  // Owner removes a user (soft-delete → gone from the directory, login blocked).
  @Roles('OWNER_ADMIN')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.users.remove(id);
  }

  @Post(':id/reset-password')
  resetPassword(@Param('id') id: string, @Body() dto: ResetUserPasswordDto) {
    return this.users.resetPassword(id, dto.password);
  }

  // Owner-only: assign/remove access-roles on an existing employee (§ RBAC). Reuses the
  // account — no duplicate login.
  @Roles('OWNER_ADMIN')
  @Patch(':id/hr-access')
  setHrAccess(@Param('id') id: string, @Body() dto: GrantAccessDto) {
    return this.users.setHrAccess(id, dto.grant);
  }

  @Roles('OWNER_ADMIN')
  @Patch(':id/campus-admin')
  setCampusAdmin(@Param('id') id: string, @Body() dto: GrantAccessDto) {
    return this.users.setCampusAdminAccess(id, dto.grant);
  }
}
