import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { AppModule } from '../../apps/api/src/app.module';
import { OPEN_BY_DESIGN } from './support/authz-open-by-design';

/**
 * Authorization coverage (Law 3, security half) — every route names its roles, or is explicitly open.
 *
 * The RolesGuard treats a route with no `@Roles()` as "any authenticated user". That is correct for a
 * handful of self-scoped / portal / public routes, and a LATENT SECURITY HOLE for anything else — it is
 * how the staff directory (`GET /staff`) came to be readable by students. This gate reads the route
 * table straight off the controllers and fails on any non-public route that declares no roles and is not
 * on the small, commented allowlist below. "Forgot @Roles" becomes a red build.
 */
const ROLES_KEY = 'roles';
const IS_PUBLIC = 'isPublic';

interface RouteMeta { method: string; path: string; hasRoles: boolean; isPublic: boolean }

describe('Route authorization coverage — every route declares @Roles or is explicitly open', () => {
  it('has no non-public route missing a role declaration', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] }).compile();
    const discovery = moduleRef.get(DiscoveryService);
    const reflector = moduleRef.get(Reflector);
    const scanner = new MetadataScanner();

    const routes: RouteMeta[] = [];
    for (const wrapper of discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const ctrlPath = (Reflect.getMetadata(PATH_METADATA, metatype) as string) ?? '';
      const proto = Object.getPrototypeOf(instance);
      scanner.getAllMethodNames(proto).forEach((name: string) => {
        const handler = proto[name];
        const verb = Reflect.getMetadata(METHOD_METADATA, handler);
        if (verb === undefined) return; // not an HTTP handler
        const routePath = (Reflect.getMetadata(PATH_METADATA, handler) as string) ?? '';
        const isPublic = !!reflector.getAllAndOverride<boolean>(IS_PUBLIC, [handler, metatype]);
        const roles = reflector.getAllAndOverride<unknown[]>(ROLES_KEY, [handler, metatype]);
        const full = `/api/v1/${ctrlPath}/${routePath}`.replace(/\/{2,}/g, '/').replace(/\/$/, '');
        routes.push({ method: RequestMethod[verb], path: full, hasRoles: Array.isArray(roles) && roles.length > 0, isPublic });
      });
    }
    await moduleRef.close();

    expect(routes.length).toBeGreaterThan(150); // non-vacuous

    const uncovered = routes
      .filter((r) => !r.isPublic && !r.hasRoles && !OPEN_BY_DESIGN.some((rx) => rx.test(r.path)))
      .map((r) => `${r.method} ${r.path}`)
      .sort();

    if (uncovered.length) {
      // eslint-disable-next-line no-console
      console.log(`\n[route-authz] ${uncovered.length} route(s) with no @Roles and no @Public:\n` + uncovered.join('\n'));
    }
    expect(uncovered).toEqual([]);
  });
});
