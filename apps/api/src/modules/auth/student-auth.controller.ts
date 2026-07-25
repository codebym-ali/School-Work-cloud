import { Body, Controller, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public, RateLimit } from '@common';
import { AuthService } from './auth.service';
import { StudentLoginDto } from './dto/auth.dto';

/**
 * Student portal sign-in (§28) — registration number + CNIC/B-Form, separate from the staff
 * email+password path. Public (no session yet) but tenant-resolved by host; rate-limited.
 */
@Public()
@Controller('portal/auth')
export class StudentAuthController {
  constructor(private readonly auth: AuthService) {}

  @RateLimit('login')
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: StudentLoginDto, @Res({ passthrough: true }) res: Response) {
    return this.auth.studentLogin(dto, res);
  }
}
