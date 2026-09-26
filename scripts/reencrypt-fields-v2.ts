/**
 * Re-encryption migration (blueprint §32, security audit 3.1): rewrite every legacy v1 (single
 * master-key) encrypted field to v2 (per-tenant HKDF key). Idempotent — only rows whose ciphertext
 * still starts with `v1.` are touched, so it is safe to run repeatedly and safe to interrupt.
 *
 * Reads across all tenants via the platform (BYPASSRLS) client, and derives each row's v2 key from
 * its own `schoolId`. Dry-run by default; pass `--commit` to write.
 *
 *   ts-node scripts/reencrypt-fields-v2.ts            # dry-run: report how many rows would move
 *   ts-node scripts/reencrypt-fields-v2.ts --commit   # actually re-encrypt
 *
 * Currently only `users.mfa_secret_enc` is populated in the schema; `cnic_enc` / `bank_account_enc`
 * are wired but unused. When they start being written, add them to FIELDS below — the loop is generic.
 */
import { PrismaClient } from '@prisma/client';
import { FieldEncryption } from '../libs/common/src/crypto/field-encryption';

const url = process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL;
const masterKey = process.env.ENCRYPTION_MASTER_KEY;
if (!url) throw new Error('PLATFORM_DATABASE_URL (or DATABASE_URL) must be set');
if (!masterKey) throw new Error('ENCRYPTION_MASTER_KEY must be set');

const prisma = new PrismaClient({ datasources: { db: { url } } });
const enc = new FieldEncryption(masterKey);
const commit = process.argv.includes('--commit');

interface Row { id: string; wire: string | null; scope: string }

/**
 * Each encrypted column that must move from v1 → v2, with the scopeId its v2 key derives from:
 * tenant data scopes on `schoolId`, vendor-side platform_users scope on their own `id` (no tenant).
 * Add rows here as `cnic_enc` / `bank_account_enc` go live — the loop is generic.
 */
const FIELDS = [
  {
    label: 'users.mfa_secret_enc',
    load: async (): Promise<Row[]> =>
      (await prisma.user.findMany({
        where: { mfaSecretEnc: { startsWith: 'v1.' } },
        select: { id: true, schoolId: true, mfaSecretEnc: true },
      })).map((r) => ({ id: r.id, wire: r.mfaSecretEnc, scope: r.schoolId })),
    write: (id: string, value: string) => prisma.user.update({ where: { id }, data: { mfaSecretEnc: value } }),
  },
  {
    label: 'platform_users.mfa_secret_enc',
    load: async (): Promise<Row[]> =>
      (await prisma.platformUser.findMany({
        where: { mfaSecretEnc: { startsWith: 'v1.' } },
        select: { id: true, mfaSecretEnc: true },
      })).map((r) => ({ id: r.id, wire: r.mfaSecretEnc, scope: r.id })),
    write: (id: string, value: string) =>
      prisma.platformUser.update({ where: { id }, data: { mfaSecretEnc: value } }),
  },
];

async function main(): Promise<void> {
  let total = 0;
  for (const field of FIELDS) {
    const rows = await field.load();
    let n = 0;
    for (const row of rows) {
      if (!row.wire) continue;
      const plaintext = enc.decrypt(row.wire); // v1 → master key, scopeId not needed
      const v2 = enc.encrypt(plaintext, row.scope);
      if (commit) await field.write(row.id, v2);
      n += 1;
    }
    console.log(`${commit ? 're-encrypted' : '[dry-run] would re-encrypt'} ${n} ${field.label} row(s) v1 → v2`);
    total += n;
  }
  console.log(`${commit ? 'Done.' : '[dry-run]'} ${total} field(s) total.${commit ? '' : ' Re-run with --commit to apply.'}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
