import { Test, type TestingModule } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import { CLS_KEYS, CommonModule, TenantViolationError } from '@common';
import {
  DatabaseModule,
  PlatformPrismaService,
  PrismaService,
  TenantPrismaService,
} from '@database';

/**
 * Merge-blocking tenant-isolation suite (blueprint §21.6). Seeds two schools and
 * asserts every cross-tenant access fails — through the real TenantPrismaService
 * (extension + withTenant + RLS), not a mock. A failure here blocks merge.
 */
describe('Tenant isolation (§21.6)', () => {
  let moduleRef: TestingModule;
  let cls: ClsService;
  let tenantPrisma: TenantPrismaService;
  let platform: PlatformPrismaService;
  let prisma: PrismaService;

  const A = randomUUID();
  const B = randomUUID();

  /** Run `fn` inside a CLS context bound to `schoolId`. */
  const asTenant = <T>(schoolId: string | undefined, fn: () => Promise<T>): Promise<T> =>
    cls.run(async () => {
      if (schoolId) cls.set(CLS_KEYS.schoolId, schoolId);
      return fn();
    });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true }), CommonModule, DatabaseModule],
    }).compile();
    await moduleRef.init();

    cls = moduleRef.get(ClsService);
    tenantPrisma = moduleRef.get(TenantPrismaService);
    platform = moduleRef.get(PlatformPrismaService);
    prisma = moduleRef.get(PrismaService);

    // Seed via the BYPASSRLS platform client (schools are not RLS'd; campuses need it).
    for (const [id, name] of [[A, 'ISO School A'], [B, 'ISO School B']] as const) {
      await platform.school.create({
        data: { id, name, subdomain: `iso-${id.slice(0, 12)}` },
      });
      await platform.campus.create({ data: { schoolId: id, name: `${name} Campus` } });
    }
  });

  afterAll(async () => {
    for (const id of [A, B]) {
      await platform.campus.deleteMany({ where: { schoolId: id } });
      await platform.school.deleteMany({ where: { id } });
    }
    await moduleRef.close();
  });

  it('scopes reads to the current tenant', async () => {
    const seen = await asTenant(A, () =>
      tenantPrisma.withTenant((tx) => tx.campus.findMany()),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].schoolId).toBe(A);
  });

  it('never returns another tenant\'s row by id (RLS backstop on findFirst)', async () => {
    const bCampus = await asTenant(B, () =>
      tenantPrisma.withTenant((tx) => tx.campus.findFirst()),
    );
    const leaked = await asTenant(A, () =>
      tenantPrisma.withTenant((tx) => tx.campus.findFirst({ where: { id: bCampus!.id } })),
    );
    expect(leaked).toBeNull();
  });

  it('auto-injects schoolId on create from the tenant context', async () => {
    const created = await asTenant(A, () =>
      tenantPrisma.withTenant((tx) => tx.campus.create({ data: { name: 'Injected Campus' } as never })),
    );
    expect(created.schoolId).toBe(A);
    await platform.campus.delete({ where: { id: created.id } });
  });

  it('blocks a write that carries a different tenant\'s schoolId', async () => {
    await expect(
      asTenant(A, () =>
        tenantPrisma.withTenant((tx) =>
          tx.campus.create({ data: { schoolId: B, name: 'Sneaky' } as never }),
        ),
      ),
    ).rejects.toThrow();
  });

  it('proves RLS independently of the extension (raw SQL inside withTenant)', async () => {
    const rows = await asTenant(A, () =>
      tenantPrisma.withTenant((tx) => tx.$queryRawUnsafe<Array<{ school_id: string }>>(
        'SELECT school_id FROM campuses',
      )),
    );
    expect(rows.length).toBe(1);
    expect(rows.every((r) => r.school_id === A)).toBe(true);
  });

  it('fails closed at the app layer when there is no tenant context', async () => {
    await expect(
      asTenant(undefined, () => tenantPrisma.withTenant((tx) => tx.campus.findMany())),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it('fails closed at the DB layer: no set_config => zero rows, no error', async () => {
    // Raw read on the app_user connection with no tenant GUC set.
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      'SELECT count(*)::int AS n FROM campuses',
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});
