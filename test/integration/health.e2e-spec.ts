import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../apps/api/src/app.module';
import { REDIS } from '@common';

/**
 * Liveness/readiness probes (blueprint §19, §31). `ready` must gate on the HARD
 * dependencies (Postgres + Redis) and return 503 when one is down, so the
 * compose/Traefik healthcheck (statusCode === 200) stops routing to a half-up node.
 */
describe('Health probes (e2e)', () => {
  describe('dependencies healthy', () => {
    let app: INestApplication;
    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix('api/v1');
      await app.init();
    });
    afterAll(async () => app?.close());

    it('live → 200 without touching dependencies', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health/live');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('ready → 200 with per-dependency checks when DB + Redis are up', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health/ready');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', checks: { db: 'ok', redis: 'ok' } });
    });
  });

  describe('Redis down', () => {
    let app: INestApplication;
    beforeAll(async () => {
      // Fake the shared Redis client: ping rejects (as it would when Redis is unreachable).
      const brokenRedis = { ping: () => Promise.reject(new Error('down')), quit: () => Promise.resolve() };
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(REDIS)
        .useValue(brokenRedis)
        .compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix('api/v1');
      await app.init();
    });
    afterAll(async () => app?.close());

    it('ready → 503 degraded, pinpointing redis as down (db still ok)', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health/ready');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'degraded', checks: { db: 'ok', redis: 'down' } });
    });

    it('live → still 200 (liveness must not depend on Redis)', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health/live');
      expect(res.status).toBe(200);
    });
  });
});
