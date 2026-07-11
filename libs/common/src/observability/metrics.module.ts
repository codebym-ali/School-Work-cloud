import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MetricsMiddleware } from './metrics.middleware';

/** Prometheus metrics (blueprint §31): the registry service + the recording middleware. */
@Global()
@Module({
  providers: [MetricsService, MetricsMiddleware],
  exports: [MetricsService, MetricsMiddleware],
})
export class MetricsModule {}
