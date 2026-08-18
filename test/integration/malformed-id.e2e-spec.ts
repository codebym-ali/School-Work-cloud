import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PlatformPrismaService } from '@database';
import { AppModule } from '../../apps/api/src/app.module';
import { ProvisioningService } from '../../apps/api/src/modules/platform/provisioning.service';
import { destroyTenant } from './support/tenant';
import { loginRequest } from './support/login';

/**
 * A malformed `:id` must never be a 5xx (blueprint §25.1).
 *
 * Found while writing the Cover C4 tests: `POST /exams/undefined/open-marks-entry` and
 * `POST /exams/undefined/results/bulk` returned **500**. The id reached Prisma unvalidated
 * and died there — `Inconsistent column data: Error creating UUID, invalid character` —
 * which `AllExceptionsFilter` could only render as an unhandled internal error. That cost
 * real time: the failure looked like the feature was broken when only the fixture was, and
 * in production it would be a Sentry page for someone else's typo.
 *
 * The routes are **enumerated from the live router**, not hand-listed, for the same reason
 * `destroyTenant` derives its table order from the FK graph: a hand-list is a promise to
 * remember, and the next `:id` route added is exactly the one nobody remembers. Every route
 * carrying an id-shaped path param is swept.
 *
 * The sweep is inherently side-effect-free: every id it sends is invalid, and `UuidParamPipe`
 * runs before the handler, so not one of these requests can reach a service — including the
 * DELETEs.
 */
describe('Malformed path ids never 5xx (e2e, §25.1)', () => {
  let app: INestApplication;
  let platform: PlatformPrismaService;
  let schoolId: string;
  let cookies: string[];

  const sub = `bad-${randomUUID().slice(0, 8)}`;
  const host = `${sub}.localhost`;
  const owner = { email: 'owner@bad.pk', password: 'Owner!Secret12' };

  const server = () => app.getHttpServer();
  const csrfOf = (c: string[]) => (c.find((x) => x.startsWith('csrf=')) ?? '').split(';')[0].slice(5);

  /** `id` and any `<entity>Id` — the convention `UuidParamPipe` enforces. */
  const ID_PARAM = /^(id|[a-z][A-Za-z0-9]*Id)$/;
  type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';
  const METHODS: Method[] = ['get', 'post', 'patch', 'put', 'delete'];

  interface Route {
    method: Method;
    /** The declared template, e.g. `/api/v1/students/:id/guardians/:guardianId`. */
    template: string;
    /** The same path with every id param replaced by the literal that started this. */
    path: string;
  }
  let routes: Route[] = [];

  /**
   * Walk Express's router for the registered routes. Deliberately defensive: if the shape
   * ever changes this must fail loudly, because a sweep over zero routes passes silently
   * and proves nothing.
   */
  const collectRoutes = (): Route[] => {
    const expressApp = app.getHttpAdapter().getInstance() as {
      _router?: { stack: { route?: { path: unknown; methods: Record<string, boolean> } }[] };
    };
    const stack = expressApp._router?.stack;
    if (!Array.isArray(stack)) throw new Error('Could not read the Express router stack — the sweep would be vacuous.');

    const out: Route[] = [];
    for (const layer of stack) {
      const template = layer.route?.path;
      if (typeof template !== 'string') continue;

      const params = [...template.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
      if (!params.some((p) => ID_PARAM.test(p))) continue;

      // Non-id params (`:token`) keep a harmless placeholder — this asserts one thing at a time.
      const path = template.replace(/:([A-Za-z0-9_]+)/g, (_, p: string) =>
        ID_PARAM.test(p) ? 'undefined' : 'placeholder',
      );
      for (const method of METHODS) if (layer.route?.methods[method]) out.push({ method, template, path });
    }
    return out;
  };

  const call = ({ method, path }: Route) => {
    let r = request(server())[method](path).set('Host', host).set('Cookie', cookies);
    if (method !== 'get') r = r.set('X-CSRF-Token', csrfOf(cookies)).set('Idempotency-Key', randomUUID());
    if (method !== 'get' && method !== 'delete') r = r.send({});
    return r;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    platform = app.get(PlatformPrismaService);
    const provisioning = app.get(ProvisioningService, { strict: false });
    const prov = await provisioning.provisionSchool({
      name: 'Bad Id School',
      subdomain: sub,
      ownerEmail: owner.email,
      ownerPassword: owner.password,
    });
    schoolId = prov.schoolId;

    // ⚠️ Via the shared helper, not `POST /auth/login` directly: the owner and staff doors were
    // split (Owner Login Plan O2/O3) after this sweep was first written, and the staff door now
    // REFUSES an owner. Hardcoding the old path would 401 here and leave `cookies` undefined,
    // which turns every route below into a 401 and the sweep into a vacuous pass.
    const res = await loginRequest(server(), host, owner.email, owner.password);
    cookies = res.headers['set-cookie'] as unknown as string[];
    if (!cookies) throw new Error('Owner login produced no session — the sweep would be vacuous.');

    routes = collectRoutes();
  });

  afterAll(async () => {
    await destroyTenant(platform, schoolId);
    await app.close();
  });

  /**
   * The two routes from the original report, pinned by name. The sweep below would catch a
   * regression here too, but these are the ones that actually burned an afternoon, and a
   * named failure says so immediately.
   */
  describe('the routes that exposed this', () => {
    it.each([
      ['POST /exams/:id/open-marks-entry', '/api/v1/exams/undefined/open-marks-entry'],
      ['POST /exams/:id/results/bulk', '/api/v1/exams/undefined/results/bulk'],
    ])('%s is a 400, not a Prisma 500', async (_label, path) => {
      const res = await call({ method: 'post', template: path, path });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details).toEqual([{ field: 'id', issue: 'must be a UUID' }]);
      // The specific 500 this replaced. Asserted on the body because that is what leaked.
      expect(JSON.stringify(res.body)).not.toMatch(/Prisma|Inconsistent column data/i);
    });
  });

  describe('every id-carrying route in the app', () => {
    it('finds a realistic number of them — a sweep over nothing proves nothing', () => {
      // ~90 today. The floor only guards against enumeration silently breaking.
      expect(routes.length).toBeGreaterThan(50);
    });

    it('answers a malformed id without a single 5xx', async () => {
      const failures: string[] = [];
      for (const route of routes) {
        const res = await call(route);
        if (res.status >= 500) failures.push(`${route.method.toUpperCase()} ${route.template} -> ${res.status}`);
      }
      expect(failures).toEqual([]);
    });

    it('answers 400 wherever the caller is allowed to reach the route at all', async () => {
      const wrong: string[] = [];
      for (const route of routes) {
        const res = await call(route);
        // 401/403 mean a guard answered first — correct, and by design: guards run before
        // pipes, so an unauthorised caller learns nothing about which ids are well-formed.
        if (res.status === 401 || res.status === 403) continue;
        if (res.status !== 400 || res.body?.error?.code !== 'VALIDATION_FAILED') {
          wrong.push(`${route.method.toUpperCase()} ${route.template} -> ${res.status} ${res.body?.error?.code ?? ''}`);
        }
      }
      expect(wrong).toEqual([]);
    });
  });

  /**
   * The other half of the contract. A well-formed id that happens not to exist is a 404 —
   * the pipe must not swallow that distinction, which is why it matches any UUID version
   * rather than v4 only (`test/matrix` drives most of its rows against the nil UUID).
   */
  it('still lets a well-formed but non-existent id through to a 404', async () => {
    const res = await request(server())
      .get(`/api/v1/students/${randomUUID()}`)
      .set('Host', host)
      .set('Cookie', cookies);

    expect(res.status).toBe(404);

    const nil = await request(server())
      .get('/api/v1/students/00000000-0000-0000-0000-000000000000')
      .set('Host', host)
      .set('Cookie', cookies);

    expect(nil.status).toBe(404);
  });
});
