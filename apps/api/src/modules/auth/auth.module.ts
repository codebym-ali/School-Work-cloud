import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { AccessDenylist } from './access-denylist.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CsrfGuard } from './guards/csrf.guard';

/**
 * Authentication module (blueprint §22). Exports the guards + TokenService/denylist
 * so the app can wire them as global guards and other modules can revoke sessions.
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    AccessDenylist,
    JwtAuthGuard,
    CsrfGuard,
  ],
  exports: [TokenService, AccessDenylist, JwtAuthGuard, CsrfGuard],
})
export class AuthModule {}
