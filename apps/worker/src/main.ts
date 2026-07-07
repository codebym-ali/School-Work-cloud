import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { initSentry, loadDotenv } from '@common';
import { WorkerModule } from './worker.module';

/**
 * Worker entrypoint. Runs as a headless application context (no HTTP listener).
 * Queue processors register themselves via DI as they are added per milestone.
 */
async function bootstrap(): Promise<void> {
  loadDotenv(); // dev: populate process.env from .env before config validation
  initSentry('worker'); // §31 — no-op without SENTRY_DSN
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  app.enableShutdownHooks(); // SmsProcessor.onModuleDestroy flushes Sentry + closes the worker
  new Logger('Worker').log('Worker started — awaiting BullMQ jobs');
}

void bootstrap();
