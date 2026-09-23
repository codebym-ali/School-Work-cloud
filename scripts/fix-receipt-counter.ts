/* One-off: advance each school's nextReceiptNo past the highest receipt the seed hand-assigned, so
 * the next real payment/reversal does not collide on (schoolId, receiptNo). */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

const envPath = join(process.cwd(), '.env');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue; const i = t.indexOf('='); if (i === -1) continue;
  const k = t.slice(0, i).trim(); if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim();
}

async function main() {
  const db = new PrismaClient({ datasourceUrl: process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL });
  try {
    for (const s of await db.school.findMany({ select: { id: true, subdomain: true, nextReceiptNo: true } })) {
      const maxPay = await db.feePayment.aggregate({ where: { schoolId: s.id }, _max: { receiptNo: true } });
      const maxRev = await db.paymentReversal.aggregate({ where: { schoolId: s.id }, _max: { receiptNo: true } });
      const next = Math.max(maxPay._max.receiptNo ?? 0, maxRev._max.receiptNo ?? 0) + 1;
      if (next > s.nextReceiptNo) {
        await db.school.update({ where: { id: s.id }, data: { nextReceiptNo: next } });
        console.log(`  ${s.subdomain}: nextReceiptNo ${s.nextReceiptNo} -> ${next}`);
      } else {
        console.log(`  ${s.subdomain}: nextReceiptNo ${s.nextReceiptNo} already ahead (max used ${next - 1})`);
      }
    }
  } finally { await db.$disconnect(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
