import { Global, Module } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';

/**
 * Provides the sliding-window rate limiter (blueprint §29). The RateLimitGuard is
 * registered as an APP_GUARD in the api composition root; it depends on this service.
 */
@Global()
@Module({
  providers: [RateLimitService],
  exports: [RateLimitService],
})
export class RateLimitModule {}
