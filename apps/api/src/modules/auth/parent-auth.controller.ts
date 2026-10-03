import { Body, Controller, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public, RateLimit } from '@common';
import { AuthService } from './auth.service';
import { ParentLoginDto, SetPortalPasswordDto, ParentForgotPasswordDto } from './dto/auth.dto';

@Public()
@Controller('portal/auth')
export class ParentAuthController {
  constructor(private readonly auth: AuthService) {}

  @RateLimit('login')
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: ParentLoginDto, @Res({ passthrough: true }) res: Response) {
    return this.auth.parentLogin(dto, res);
  }

  @RateLimit('login')
  @Post('set-password')
  @HttpCode(HttpStatus.OK)
  setPassword(@Body() dto: SetPortalPasswordDto, @Res({ passthrough: true }) res: Response) {
    return this.auth.setPortalPassword(dto, res);
  }

  @RateLimit('login')
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  forgotPassword(@Body() dto: ParentForgotPasswordDto) {
    return this.auth.parentForgotPassword(dto);
  }
}
