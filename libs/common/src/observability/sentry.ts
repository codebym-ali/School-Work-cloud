import * as Sentry from '@sentry/node';

/**
 * Thin Sentry wrapper (blueprint §31 observability). Error monitoring is opt-in:
 * with no `SENTRY_DSN` set (dev/test/CI) every function here is a no-op, so nothing
 * new runs in those environments. Initialised once at process bootstrap for both the
 * api and the worker; the exception filter and the queue processor feed it errors
 * with tenant/request context (never PII).
 */
let enabled = false;

export interface ErrorContext {
  requestId?: string;
  schoolId?: string;
  userId?: string;
  method?: string;
  url?: string;
  jobId?: string;
  queue?: string;
}

/** Initialise Sentry from env. Returns whether it was enabled. Safe to call once per process. */
export function initSentry(serverName: string): boolean {
  if (enabled) return true;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    serverName,
    environment: process.env.NODE_ENV ?? 'development',
    // Errors only by default; turn tracing on explicitly in prod if/when needed.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
  });
  enabled = true;
  return true;
}

export function isSentryEnabled(): boolean {
  return enabled;
}

/** Report an error with tenant/request context. No-op unless Sentry is enabled. */
export function captureError(error: unknown, context: ErrorContext = {}): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    // Searchable tags — never include PII.
    if (context.schoolId) scope.setTag('schoolId', context.schoolId);
    if (context.userId) scope.setTag('userId', context.userId);
    if (context.requestId) scope.setTag('requestId', context.requestId);
    if (context.queue) scope.setTag('queue', context.queue);
    if (context.jobId) scope.setTag('jobId', context.jobId);
    if (context.method || context.url) {
      scope.setContext('request', { method: context.method, url: context.url });
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
  });
}

/** Flush buffered events on shutdown. No-op unless Sentry is enabled. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!enabled) return;
  await Sentry.close(timeoutMs);
}
