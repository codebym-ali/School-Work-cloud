import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { AppModule } from '../../apps/api/src/app.module';
import { PERMISSION_MATRIX } from '../matrix/permission-matrix';
import { OPEN_BY_DESIGN, normalizePath } from './support/authz-open-by-design';

/**
 * Authorization coverage (Law 3, security half — the OTHER half of `route-authz-coverage`).
 *
 * `route-authz-coverage` proves every route *declares* `@Roles`. It cannot prove the role set is *correct* —
 * a route gated to the wrong roles still passes it. That is what the permission matrix + `matrix-conformance`
 * assert (role × route, deny side is the guarantee). But the matrix is hand-maintained, so a NEW role-gated
 * route can ship with no row and be silently unmeasured — the exact failure the matrix's own comments warn
 * about ("a route with no row is not assumed safe, it is unmeasured").
 *
 * This gate closes that: it reads the live route table and fails on any role-gated route (declares `@Roles`,
 * not public, not self-scoped) that has NO matching row in the permission matrix. "Added a route, forgot its
 * matrix row" becomes a red build, so `matrix-conformance` can never fall behind the surface it guards.
 */
const IS_PUBLIC = 'isPublic';
const ROLES_KEY = 'roles';

describe('Route ↔ permission-matrix coverage — every role-gated route has a matrix row', () => {
  it('has no role-gated route missing from the permission matrix', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] }).compile();
    const discovery = moduleRef.get(DiscoveryService);
    const reflector = moduleRef.get(Reflector);
    const scanner = new MetadataScanner();

    // What the matrix covers, as a set of `METHOD normalized/path` keys.
    const covered = new Set(
      PERMISSION_MATRIX.map((r) => `${r.method.toUpperCase()} ${normalizePath(r.path)}`),
    );

    const uncovered: string[] = [];
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
        const hasRoles = Array.isArray(roles) && roles.length > 0;

        const full = `/api/v1/${ctrlPath}/${routePath}`.replace(/\/{2,}/g, '/').replace(/\/$/, '');
        // Only role-gated routes need a matrix row. Public + self-scoped (OPEN_BY_DESIGN) are exempt by
        // design; a route with no @Roles at all is the other gate's failure, not this one's.
        if (isPublic || !hasRoles) return;
        if (OPEN_BY_DESIGN.some((rx) => rx.test(full))) return;

        const method = RequestMethod[verb];
        const key = `${method} ${normalizePath(full)}`;
        if (!covered.has(key)) uncovered.push(`${method} ${full}`);
      });
    }
    await moduleRef.close();

    if (uncovered.length) {
      // eslint-disable-next-line no-console
      console.log(
        `\n[matrix-coverage] ${uncovered.length} role-gated route(s) with no permission-matrix row:\n` +
          uncovered.sort().join('\n') +
          '\n→ add a row to test/matrix/permission-matrix.ts naming the roles RolesGuard must admit.',
      );
    }
    expect(uncovered.sort()).toEqual([]);
  });
});
