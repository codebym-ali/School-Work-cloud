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
    return this.auth.login(dto, res, 'staff');
  }

  /**
   * The school owner's own entrance (Owner Login Plan). Refuses everyone else — with a response
   * byte-identical to a wrong password, so it cannot be used to discover which address is the
   * owner's.
   *
   * ⚠️ **Same `@RateLimit('login')` as the staff door, on purpose.** The limiter keys on
   * `rl:{policy}:{scope}:{id}` — the POLICY, not the route — so both doors share one bucket and an
   * attacker gets 5 attempts per IP across the pair. A policy of its own would give them 5 per door
   * and **halve** the protection the split was supposed to improve.
   */
  @Public()
  @RateLimit('login')
  @Post('owner-login')
  @HttpCode(HttpStatus.OK)
  ownerLogin(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    return this.auth.login(dto, res, 'owner');
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

  /**
   * Completes enrolment AND returns the ten recovery codes — the only time they are ever
   * visible. This deliberately returns 200 with a body rather than the 204 it used to: issuing
   * codes the caller then discards would leave a user with a mandatory second factor and no way
   * back in, which is the exact lockout this feature exists to prevent.
   */
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  mfaVerify(@CurrentUser() user: RequestUser, @Body() dto: MfaVerifyDto) {
    return this.auth.mfaVerify(user, dto);
  }

  @Delete('mfa')
  @HttpCode(HttpStatus.NO_CONTENT)
  async disableMfa(@CurrentUser() user: RequestUser, @Body() dto: DisableMfaDto) {
    await this.auth.disableMfa(user, dto);
  }

  /**
   * How many recovery codes remain. The only readable fact about them — the codes themselves
   * are argon2 hashes and can never be shown again after generation.
   */
  @Get('mfa/recovery-codes')
  recoveryCodeStatus(@CurrentUser() user: RequestUser) {
    return this.auth.recoveryCodeStatus(user.userId);
  }

  /**
   * Issue a fresh set of ten, invalidating the old set. Returns the plaintext ONCE — if the
   * caller doesn't show them immediately, the user has none.
   */
  @Post('mfa/recovery-codes')
  @HttpCode(HttpStatus.OK)
  async regenerateRecoveryCodes(@CurrentUser() user: RequestUser) {
    return { recoveryCodes: await this.auth.regenerateRecoveryCodes(user.userId) };
  }

  @Get('me')
  me(@CurrentUser() user: RequestUser) {
    return this.auth.me(user);
  }
}
