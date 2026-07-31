import { Module } from '@nestjs/common';
import { SetupModule } from '../setup/setup.module';
import { ClassTestsController } from './class-tests.controller';
import { ClassTestsService } from './class-tests.service';

/**
 * Class tests (§11 extension) — a separate module from Exams on purpose. Exams carry weightage
 * and drive report cards; class tests are formative and never do. Keeping them apart stops the
 * two being conflated as the code grows.
 */
@Module({
  imports: [SetupModule],
  controllers: [ClassTestsController],
  providers: [ClassTestsService],
  exports: [ClassTestsService],
})
export class ClassTestsModule {}
