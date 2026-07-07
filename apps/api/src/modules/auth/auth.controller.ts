import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentUser, Public, RateLimit, type RequestUser } from '@common';
import { AuthService } from './auth.service';
import { REFRESH_COOKIE } from './auth.cookies';
import {
  ChangePasswordDto,
  DisableMfaDto,
  ForgotPasswordDto,
  LoginDto,
  MfaChallengeDto,
  MfaVerifyDto,
  ResetPasswordDto,
} from './dto/auth.dto';

/** Auth endpoints (blueprint §24 Auth). Cookies are set via passthrough Response. */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @RateLimit('login')
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    return this.auth.login(dto, res);
  }

  @Public()
  @RateLimit('login')
  @Post('mfa/challenge')
  @HttpCode(HttpStatus.OK)
  mfaChallenge(@Body() dto: MfaChallengeDto, @Res({ passthrough: true }) res: Response) {
    return this.auth.mfaChallenge(dto, res);
  }

  @Public()
  @RateLimit('refresh')
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    return this.auth.refresh(raw, res);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    await this.auth.logout(raw, res);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.auth.forgotPassword(dto);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(@CurrentUser() user: RequestUser, @Body() dto: ChangePasswordDto) {
    await this.auth.changePassword(user, dto);
  }

  @Post('mfa/setup')
  mfaSetup(@CurrentUser() user: RequestUser) {
    return this.auth.mfaSetup(user);
  }

  @Post('mfa/verify')
  @HttpCode(HttpStatus.NO_CONTENT)
  async mfaVerify(@CurrentUser() user: RequestUser, @Body() dto: MfaVerifyDto) {
    await this.auth.mfaVerify(user, dto);
  }

  @Delete('mfa')
  @HttpCode(HttpStatus.NO_CONTENT)
  async disableMfa(@CurrentUser() user: RequestUser, @Body() dto: DisableMfaDto) {
    await this.auth.disableMfa(user, dto);
  }

  @Get('me')
  me(@CurrentUser() user: RequestUser) {
    return this.auth.me(user);
  }
}
