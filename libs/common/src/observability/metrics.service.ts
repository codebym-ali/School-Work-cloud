import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

/**
 * Prometheus metrics registry (blueprint §31). Exposes default process/node metrics plus
 * an HTTP request-duration histogram (golden signals: latency, traffic, error rate via the
 * `status` label). Its own isolated Registry so tests/multiple instances don't clash.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly httpDuration: Histogram<'method' | 'route' | 'status'>;

  constructor() {
    this.registry.setDefaultLabels({ app: 'school-api' });
    collectDefaultMetrics({ register: this.registry });
    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds, labelled by method, route pattern and status',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.01, 0.05, 0.1, 0.3, 0.6, 1, 2, 5],
      registers: [this.registry],
    });
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
