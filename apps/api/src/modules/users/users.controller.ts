import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Roles } from '@common';
import { UsersService } from './users.service';
import { CreateUserDto, ResetUserPasswordDto, UpdateUserDto } from './dto/users.dto';

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

  @Roles('OWNER_ADMIN')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }

  @Post(':id/reset-password')
  resetPassword(@Param('id') id: string, @Body() dto: ResetUserPasswordDto) {
    return this.users.resetPassword(id, dto.password);
  }
}
