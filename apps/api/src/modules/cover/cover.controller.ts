import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { Roles } from '@common';
import { CoverService } from './cover.service';
import { CoverQuery, CreateCoverDto } from './dto/cover.dto';

/**
 * Cover (Cover Plan, C0).
 *
 * **Arranging cover is a permission grant**, so it sits with the people who approve leave:
 * OWNER_ADMIN and CAMPUS_ADMIN. The campus half is narrowed in the service, not here — §22.8
 * guards run before the tenant transaction and would read zero rows.
 *
 * A teacher does not need a route of their own: cover simply makes `POST /attendance/bulk` start
 * working for that section, and their existing screens show it.
 */
@Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
@Controller('cover')
export class CoverController {
  constructor(private readonly cover: CoverService) {}

  @Get()
  list(@Query() q: CoverQuery) {
    return this.cover.list(q);
  }

  @Post()
  create(@Body() dto: CreateCoverDto) {
    return this.cover.create(dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.cover.remove(id);
  }
}
