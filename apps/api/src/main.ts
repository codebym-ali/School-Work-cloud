import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ENV, initSentry, loadDotenv, type Env } from '@common';

async function bootstrap(): Promise<void> {
  loadDotenv(); // dev: populate process.env from .env before config validation
  initSentry('api'); // §31 — early, so bootstrap failures are captured (no-op without SENTRY_DSN)
  // bufferLogs so early logs flush through Pino once useLogger is set (§31 structured logs).
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));
  const env = app.get<Env>(ENV);
  const isProd = env.NODE_ENV === 'production';

  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  // Web hardening (§22.7): CSP, HSTS, frame-ancestors none, etc.
  // CSP is relaxed off-production so the Swagger UI explorer (inline assets) can run.
  app.use(
    helmet({
      contentSecurityPolicy: isProd ? { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"] } } : false,
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

  // Interactive API explorer (non-production only). Served at /api/docs.
  // Log in via POST /auth/login (sets cookies), then paste the `csrf` cookie value
  // into "Authorize" so state-changing calls carry X-CSRF-Token. addServer prepends
  // the global prefix so "Try it out" hits /api/v1/*.
  if (!isProd) {
    const config = new DocumentBuilder()
      .setTitle('School Management API')
      .setDescription('Dev explorer. Use a tenant host (e.g. demo.localhost). Log in, then paste the `csrf` cookie into Authorize.')
      .setVersion('0.1.0')
      .addServer('/api/v1')
      .addApiKey({ type: 'apiKey', in: 'header', name: 'X-CSRF-Token' }, 'csrf')
      .build();
    const doc = SwaggerModule.createDocument(app, config, { ignoreGlobalPrefix: true });
    SwaggerModule.setup('api/docs', app, doc, {
      swaggerOptions: { withCredentials: true, persistAuthorization: true },
    });
  }

  app.enableShutdownHooks();
  await app.listen(env.API_PORT);
  const log = new Logger('Bootstrap');
  log.log(`API listening on :${env.API_PORT} (prefix /api/v1)`);
  if (!isProd) log.log(`API explorer at /api/docs`);
}

void bootstrap();
