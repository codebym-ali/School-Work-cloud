import { Module } from '@nestjs/common';
import { SetupModule } from '../setup/setup.module';
import { CommsModule } from '../comms/comms.module';
import { AccessModule } from '../access/access.module';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';
import { GuardiansService } from './guardians.service';
import { StudentsImportService } from './students-import.service';
import { PhoneVerificationService } from './phone-verification.service';
import { PortalCredentialsService } from './portal-credentials.service';

@Module({
  imports: [SetupModule, CommsModule, AccessModule, AuthModule, MailModule],
  controllers: [StudentsController],
  providers: [StudentsService, GuardiansService, StudentsImportService, PhoneVerificationService, PortalCredentialsService],
  exports: [StudentsService, GuardiansService],
})
export class StudentsModule {}
