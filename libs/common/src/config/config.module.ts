import { Global, Module } from '@nestjs/common';
import { validateEnv, type Env } from './env.schema';

/** DI token for the validated, typed environment config. */
export const ENV = Symbol('ENV');

/**
 * Global config: validates process.env once at boot via Zod and exposes the
 * typed result under the ENV token. Any invalid/missing var crashes startup.
 */
@Global()
@Module({
  providers: [
    {
      provide: ENV,
      useFactory: (): Env => validateEnv(process.env),
    },
  ],
  exports: [ENV],
})
export class ConfigModule {}
