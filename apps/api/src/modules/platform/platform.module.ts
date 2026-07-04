import { Module } from '@nestjs/common';
import { ProvisioningService } from './provisioning.service';

/**
 * Platform / vendor-side module (blueprint §5, §24). For now exposes the
 * ProvisioningService used to bootstrap tenants; the PLATFORM_ADMIN vendor
 * console (suspend/reactivate, SMS credits, analytics, export) is a later milestone.
 */
@Module({
  providers: [ProvisioningService],
  exports: [ProvisioningService],
})
export class PlatformModule {}
