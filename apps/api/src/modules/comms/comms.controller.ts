import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Public, Roles } from '@common';
import { CommsService } from './comms.service';
import { ManualSendDto, SmsLogQuery, SmsWebhookDto, UpsertTemplateDto } from './dto/comms.dto';

// ⚠️ Admin-only by default: SMS logs carry parents' phone numbers and message bodies, and the
// credit balance is finance data — none of it is a teacher's to read. The GET handlers previously
// carried NO @Roles, so any authenticated user could read all of it; this was latent because there
// was no screen, and it surfaced when the route-coverage gate asked why these routes had no UI.
// PUT templates narrows further to the owner (below); the delivery webhook is a SEPARATE @Public
// controller.
@Controller('sms')
@Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
export class SmsController {
  constructor(private readonly comms: CommsService) {}

  @Get('templates')
  listTemplates() {
    return this.comms.listTemplates();
  }

  @Roles('OWNER_ADMIN')
  @Put('templates')
  upsertTemplate(@Body() dto: UpsertTemplateDto) {
    return this.comms.upsertTemplate(dto);
  }

  @Get('credits')
  credits() {
    return this.comms.creditBalance();
  }

  @Get('logs')
  logs(@Query() q: SmsLogQuery) {
    return this.comms.listLogs(q);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post('send')
  @HttpCode(HttpStatus.ACCEPTED)
  send(@Body() dto: ManualSendDto) {
    return this.comms.sendManual(dto);
  }

  @Roles('OWNER_ADMIN', 'CAMPUS_ADMIN')
  @Post('logs/:id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  async retry(@Param('id') id: string) {
    await this.comms.retry(id);
  }
}

/** Public, HMAC-authenticated delivery receipts (blueprint §14, §19 public list). */
@Controller('webhooks/sms')
export class SmsWebhookController {
  constructor(private readonly comms: CommsService) {}

  @Public()
  @Post(':provider')
  @HttpCode(HttpStatus.NO_CONTENT)
  async receive(
    @Param('provider') _provider: string,
    @Headers('x-signature') signature: string,
    @Body() dto: SmsWebhookDto,
  ) {
    await this.comms.handleWebhook(signature, dto);
  }
}
