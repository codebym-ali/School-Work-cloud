import { Module } from '@nestjs/common';
import { SetupModule } from '../setup/setup.module';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';
import { GuardiansService } from './guardians.service';
import { StudentsImportService } from './students-import.service';

@Module({
  imports: [SetupModule],
  controllers: [StudentsController],
  providers: [StudentsService, GuardiansService, StudentsImportService],
  exports: [StudentsService, GuardiansService],
})
export class StudentsModule {}
