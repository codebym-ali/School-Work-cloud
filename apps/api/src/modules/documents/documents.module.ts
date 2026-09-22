import { Module } from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';

/** Read access to issued documents — report-card PDFs (blueprint §15, §22.6). Certificate
 *  issuance was removed on 2026-09-19; withdrawal now lives in the withdrawal module. */
@Module({
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
