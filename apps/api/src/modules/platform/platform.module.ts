import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProvisioningService } from './provisioning.service';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformService } from './platform.service';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformAuthGuard } from './platform-auth.guard';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformController } from './platform.controller';

/**
 * Platform / vendor-side module (blueprint §5, §24). Provides tenant provisioning and
 * the vendor console: cross-tenant auth (`platform_users`, no RLS) + tenant management
 * (list / suspend / reactivate) on the platform_admin BYPASSRLS connection. Imports
 * AuthModule for TokenService + PasswordService (shared JWT/crypto).
 */
@Module({
  imports: [AuthModule],
  controllers: [PlatformAuthController, PlatformController],
  providers: [ProvisioningService, PlatformAuthService, PlatformService, PlatformAuditService, PlatformAuthGuard],
  exports: [ProvisioningService],
})
export class PlatformModule {}
