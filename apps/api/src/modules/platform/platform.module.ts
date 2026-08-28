import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProvisioningService } from './provisioning.service';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformService } from './platform.service';
import { PlatformBillingService } from './platform-billing.service';
import { PlatformLeadsService } from './platform-leads.service';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformAuthGuard } from './platform-auth.guard';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformController } from './platform.controller';
import { PlatformBillingController } from './platform-billing.controller';
import { PlatformPublicController } from './platform-public.controller';
import { PlatformLeadsController } from './platform-leads.controller';

/**
 * Platform / vendor-side module (blueprint §5, §24). Provides tenant provisioning and
 * the vendor console: cross-tenant auth (`platform_users`, no RLS) + tenant management
 * (list / suspend / reactivate) on the platform_admin BYPASSRLS connection. Imports
 * AuthModule for TokenService + PasswordService (shared JWT/crypto).
 */
@Module({
  imports: [AuthModule],
  controllers: [PlatformAuthController, PlatformController, PlatformBillingController, PlatformPublicController, PlatformLeadsController],
  providers: [ProvisioningService, PlatformAuthService, PlatformService, PlatformBillingService, PlatformLeadsService, PlatformAuditService, PlatformAuthGuard],
  exports: [ProvisioningService],
})
export class PlatformModule {}
