import { Module } from '@nestjs/common';
import { MailerService } from './mail.service';

/** Outbound email (shared). Config comes from the @Global ConfigModule (ENV), so this only wires the
 *  service. Import it wherever a module needs to send mail (e.g. PlatformModule for lead notifications). */
@Module({
  providers: [MailerService],
  exports: [MailerService],
})
export class MailModule {}
