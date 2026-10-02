/**
 * Backfill cnicHash on ParentProfile rows that have cnicEnc but no cnicHash.
 * Decrypts each CNIC, normalises it, and writes the HMAC-SHA256 hash used by the
 * parent auto-match tier-1 lookup.
 *
 *   ts-node scripts/backfill-parent-cnic-hash.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { FieldEncryption } from '../libs/common/src/crypto/field-encryption';
import { normalizeCnic } from '../libs/common/src/util/validate-cnic';
import { normalizePkName } from '../libs/common/src/util/normalize-name';

const envPath = join(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim();
  }
}

const BATCH = 200;

function hashCnic(cnic: string, masterKey: string): string {
  return createHmac('sha256', masterKey).update(cnic).digest('hex');
}

async function main() {
  const masterKey = process.env.ENCRYPTION_MASTER_KEY;
  if (!masterKey) throw new Error('ENCRYPTION_MASTER_KEY is not set');

  const crypto = new FieldEncryption(masterKey);
  const db = new PrismaClient({
    datasourceUrl: process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL,
  });

  try {
    const total = await db.parentProfile.count({
      where: { cnicEnc: { not: null }, cnicHash: null },
    });
    console.log(`Found ${total} parent profiles to backfill.`);
    if (total === 0) return;

    let processed = 0;
    let errors = 0;

    while (true) {
      const rows = await db.parentProfile.findMany({
        where: { cnicEnc: { not: null }, cnicHash: null },
        select: { id: true, schoolId: true, cnicEnc: true, fullName: true, fullNameNorm: true },
        take: BATCH,
      });
      if (rows.length === 0) break;

      for (const row of rows) {
        try {
          const plain = crypto.decrypt(row.cnicEnc!, row.schoolId);
          const normalized = normalizeCnic(plain);
          if (!normalized) {
            console.warn(`  ⚠ ${row.id}: invalid CNIC format after decrypt, skipping`);
            errors++;
            continue;
          }

          const data: Record<string, string> = { cnicHash: hashCnic(normalized, masterKey) };
          if (!row.fullNameNorm && row.fullName) {
            data.fullNameNorm = normalizePkName(row.fullName);
          }

          await db.parentProfile.update({ where: { id: row.id }, data });
          processed++;
        } catch (e: any) {
          console.warn(`  ⚠ ${row.id}: ${e.message}`);
          errors++;
        }
      }

      console.log(`  … ${processed + errors}/${total}`);
    }

    console.log(`✔ Backfill complete: ${processed} updated, ${errors} errors.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
