import { Controller, Get, Param, Query } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import { Roles } from '@common';
import { DocumentsService } from './documents.service';

class DocumentListQuery {
  @IsUUID() studentId!: string;
}

/**
 * Read access to issued documents — currently report-card PDFs (§15, §22.6). Restricted to the
 * admin roles and campus-scoped in the service.
 *
 * ⚠️ Certificate issuance was removed on 2026-09-19; there is no longer a write route here.
 */
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Get()
  list(@Query() q: DocumentListQuery) {
    return this.documents.listForStudent(q.studentId);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Get(':id/url')
  url(@Param('id') id: string) {
    return this.documents.getUrl(id);
  }
}
