import { Body, Controller, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public, RateLimit } from '@common';
import { AuthService } from './auth.service';
import { StudentLoginDto } from './dto/auth.dto';

/**
 * Parent portal sign-in (§28) — child's registration number + guardian CNIC, separate from
 * the staff email+password path. Public (no session yet) but tenant-resolved by host; rate-limited.
 */
@Public()
@Controller('portal/auth')
export class ParentAuthController {
  constructor(private readonly auth: AuthService) {}

  @RateLimit('login')
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: StudentLoginDto, @Res({ passthrough: true }) res: Response) {
    return this.auth.parentLogin(dto, res);
  }
}
