-- Advance-application payments (blueprint §12): when a guardian's advance/credit is applied
-- to an invoice, it is recorded as a FeePayment with method ADVANCE so recompute, receipts
-- and the fee-integrity check all stay consistent. (This migration only ADDS the value; it
-- does not use it, so it is safe inside Prisma's migration transaction on PG16.)
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'ADVANCE';
