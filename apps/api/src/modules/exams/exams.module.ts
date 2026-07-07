import { Module } from '@nestjs/common';
import { CommsModule } from '../comms/comms.module';
import { ExamSetupService } from './exam-setup.service';
import { ExamsService } from './exams.service';
import { ReportCardsService } from './report-cards.service';
import {
  ExamsController,
  GradeScalesController,
  StudentReportCardsController,
  TermsController,
} from './exams.controller';

/** Examinations, grading & report cards (blueprint §11). */
@Module({
  imports: [CommsModule],
  controllers: [GradeScalesController, TermsController, ExamsController, StudentReportCardsController],
  providers: [ExamSetupService, ExamsService, ReportCardsService],
  exports: [ExamSetupService, ExamsService, ReportCardsService],
})
export class ExamsModule {}
