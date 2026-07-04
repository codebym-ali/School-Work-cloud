import { Global, Module } from '@nestjs/common';
import { ConfigModule, ENV } from './config/config.module';
import type { Env } from './config/env.schema';
import { TenantContext } from './context/tenant-context';
import { FieldEncryption } from './crypto/field-encryption';
import { RolesGuard } from './guards/roles.guard';
import { TenantScopeGuard } from './guards/tenant-scope.guard';

/** DI token for the AES-256-GCM field encryptor. */
export const FIELD_ENCRYPTION = Symbol('FIELD_ENCRYPTION');

/**
 * Cross-cutting providers shared by api + worker: config, tenant context,
 * field encryption, and the reusable guards.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    TenantContext,
    RolesGuard,
    TenantScopeGuard,
    {
      provide: FIELD_ENCRYPTION,
      inject: [ENV],
      useFactory: (env: Env) => new FieldEncryption(env.ENCRYPTION_MASTER_KEY),
    },
  ],
  exports: [ConfigModule, TenantContext, RolesGuard, TenantScopeGuard, FIELD_ENCRYPTION],
})
export class CommonModule {}
