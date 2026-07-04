import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ENV, type Env } from '@common';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const env = app.get<Env>(ENV);

  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  // Web hardening (§22.7): CSP, HSTS, frame-ancestors none, etc.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"] } },
    }),
  );
  // Same-origin only — the app is served from the tenant domain (§22.7).
  app.enableCors({ origin: false, credentials: true });

  // Global whitelist validation (§22.7): unknown fields rejected.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.enableShutdownHooks();
  await app.listen(env.API_PORT);
  new Logger('Bootstrap').log(`API listening on :${env.API_PORT} (prefix /api/v1)`);
}

void bootstrap();
