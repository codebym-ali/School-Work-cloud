import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService, Public, SkipRateLimit } from '@common';

/**
 * Prometheus scrape endpoint (blueprint §31). Public + rate-limit-exempt + host-exempt
 * (excluded from tenant resolution in AppModule) — it exposes no tenant data, only
 * process/HTTP aggregates. Served at /api/v1/metrics.
 */
@SkipRateLimit()
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(@Res({ passthrough: true }) res: Response): Promise<string> {
    res.setHeader('Content-Type', this.metrics.contentType);
    return this.metrics.metrics();
  }
}
