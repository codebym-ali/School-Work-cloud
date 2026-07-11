import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * Records every response into the request-duration histogram on `finish` — so it also
 * counts guard-denied (403) and unmatched (404) responses, which a route interceptor
 * would miss (interceptors run after guards). The `route` label is the matched Express
 * route pattern (e.g. `/students/:id`), keeping cardinality bounded; unmatched → `unmatched`.
 */
@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const route = (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.metrics.httpDuration.observe({ method: req.method, route, status: String(res.statusCode) }, seconds);
    });
    next();
  }
}
