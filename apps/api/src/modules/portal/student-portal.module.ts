import { Module } from '@nestjs/common';
import { StudentPortalController } from './student-portal.controller';
import { StudentPortalService } from './student-portal.service';
import { ParentPortalController } from './parent-portal.controller';
import { ParentPortalService } from './parent-portal.service';

/** Self-service portals — STUDENT (self-scoped) and PARENT (guardian-scoped) (blueprint §28). */
@Module({
  controllers: [StudentPortalController, ParentPortalController],
  providers: [StudentPortalService, ParentPortalService],
})
export class StudentPortalModule {}
