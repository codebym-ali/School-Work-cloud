-- Who marked a payslip paid (Cash Payroll Plan, WS1.1).
--
-- Salaries are handed over in cash by the campus accountant, so "who handed it over" is the whole record.
-- Nullable: payslips paid before this column existed have no recorded payer, and saying so beats inventing one.
ALTER TABLE "payslips" ADD COLUMN "paid_by_id" UUID;
