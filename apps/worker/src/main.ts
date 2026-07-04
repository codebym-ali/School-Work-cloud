import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';

/**
 * Worker entrypoint. Runs as a headless application context (no HTTP listener).
 * Queue processors register themselves via DI as they are added per milestone.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  app.enableShutdownHooks();
  new Logger('Worker').log('Worker started — awaiting BullMQ jobs');
}

void bootstrap();
