import { Module } from '@nestjs/common';
import { StudentPortalController } from './student-portal.controller';
import { StudentPortalService } from './student-portal.service';

/** Student self-service portal — self-scoped (blueprint §28). The parent portal was removed
 *  on 2026-07-28: parents get no logins (see Key Decisions). Guardian DATA is unaffected —
 *  admissions still require a guardian and every SMS still resolves the primary guardian. */
@Module({
  controllers: [StudentPortalController],
  providers: [StudentPortalService],
})
export class StudentPortalModule {}
