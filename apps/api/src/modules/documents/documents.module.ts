import { Module } from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { DocumentsController, WithdrawalController } from './documents.controller';

/** Documents & certificates (blueprint §15). */
@Module({
  controllers: [DocumentsController, WithdrawalController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
