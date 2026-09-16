import { Module } from '@nestjs/common';
import { FeesModule } from '../fees/fees.module';
import { DocumentsService } from './documents.service';
import { DocumentsController, WithdrawalController } from './documents.controller';

/** Documents & certificates (blueprint §15). */
@Module({
  // Withdrawal closes invoices already raised for months after the student left (see withdraw()).
  imports: [FeesModule],
  controllers: [DocumentsController, WithdrawalController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
