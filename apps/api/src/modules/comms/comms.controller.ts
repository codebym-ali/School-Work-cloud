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

@Controller('sms')
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
