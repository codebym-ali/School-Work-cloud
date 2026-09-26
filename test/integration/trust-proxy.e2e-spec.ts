import { Controller, Get, type INestApplication, Module, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request } from 'express';
import request from 'supertest';
import { parseTrustProxy } from '@common';

/**
 * Proxy trust boundary (blueprint §22, security audit 2.3).
 *
 * The audit's exact ask: "add an integration test asserting `req.ip` reflects a synthetic
 * `X-Forwarded-For` header when running behind the configured proxy count." This proves the two
 * directions that matter for the §29 rate limiter and the §31 audit trail:
 *   - a TRUSTED peer's `X-Forwarded-For` is believed (so the limiter keys per real client), and
 *   - an UNTRUSTED peer's `X-Forwarded-For` is ignored (so a public client cannot spoof its IP).
 *
 * It boots a tiny app and sets `trust proxy` **exactly as `apps/api/src/main.ts` does** — via
 * `parseTrustProxy(...)` on the Express instance — so a regression in either the parser or the
 * wiring fails here. No database or queue: this is pure request-plumbing.
 */
@Controller()
class ProbeController {
  @Get('_ip')
  ip(@Req() req: Request): { ip?: string; protocol: string; secure: boolean } {
    return { ip: req.ip, protocol: req.protocol, secure: req.secure };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

async function appWith(trustProxy: string): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  // Mirror main.ts precisely — the boundary is set on the underlying Express instance.
  (app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void }).set(
    'trust proxy',
    parseTrustProxy(trustProxy),
  );
  await app.init();
  return app;
}

describe('Proxy trust boundary (§22, audit 2.3)', () => {
  it('believes X-Forwarded-For when the immediate peer is trusted (uniquelocal/loopback edge)', async () => {
    // supertest connects over the loopback interface, so `loopback` trusts this hop — the same
    // shape as prod, where the docker-internal Caddy/Traefik peer is a trusted private address.
    const app = await appWith('loopback');
    const res = await request(app.getHttpServer()).get('/_ip').set('X-Forwarded-For', '203.0.113.7');
    expect(res.status).toBe(200);
    expect(res.body.ip).toBe('203.0.113.7');
    await app.close();
  });

  it('IGNORES a forged X-Forwarded-For when trust is off (anti-spoof)', async () => {
    const app = await appWith('false');
    const res = await request(app.getHttpServer()).get('/_ip').set('X-Forwarded-For', '203.0.113.7');
    // With trust off, req.ip stays the real socket peer (loopback), never the attacker's header.
    expect(res.body.ip).not.toBe('203.0.113.7');
    await app.close();
  });

  it('reflects X-Forwarded-Proto=https from a trusted proxy (drives req.secure)', async () => {
    const app = await appWith('loopback');
    const res = await request(app.getHttpServer()).get('/_ip').set('X-Forwarded-Proto', 'https');
    expect(res.body.protocol).toBe('https');
    expect(res.body.secure).toBe(true);
    await app.close();
  });

  it('keys distinct clients to distinct req.ip — the concrete §29 limiter win', async () => {
    // The bug this fixes: without trust proxy every client shared ONE bucket (the proxy IP). Here
    // two forwarded clients resolve to two ips, which is what makes the IP-scoped limiter per-client.
    const app = await appWith('loopback');
    const a = await request(app.getHttpServer()).get('/_ip').set('X-Forwarded-For', '198.51.100.1');
    const b = await request(app.getHttpServer()).get('/_ip').set('X-Forwarded-For', '198.51.100.2');
    expect(a.body.ip).toBe('198.51.100.1');
    expect(b.body.ip).toBe('198.51.100.2');
    expect(a.body.ip).not.toBe(b.body.ip);
    await app.close();
  });
});
