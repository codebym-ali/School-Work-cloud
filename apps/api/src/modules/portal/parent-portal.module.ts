import { Module } from '@nestjs/common';
import { ParentPortalController } from './parent-portal.controller';
import { ParentPortalService } from './parent-portal.service';
import { FeesModule } from '../fees/fees.module';

/** Parent portal — self-scoped (blueprint §28). */
@Module({
  imports: [FeesModule],
  controllers: [ParentPortalController],
  providers: [ParentPortalService],
})
export class ParentPortalModule {}
