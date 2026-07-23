import { Module } from '@nestjs/common';
import { AccessService } from './access.service';

/** Module (functionality) access control — shared across HR, admissions and fees. */
@Module({
  providers: [AccessService],
  exports: [AccessService],
})
export class AccessModule {}
