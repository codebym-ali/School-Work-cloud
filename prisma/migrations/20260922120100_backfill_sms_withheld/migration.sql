-- Move existing withheld rows off FAILED and onto the new WITHHELD status. Keyed on fail_reason,
-- not the "(withheld: …)" message text: the reason is the fact, the placeholder body is only how it
-- was shown. In its own migration because Postgres forbids USING a new enum value in the same
-- transaction that added it (see 20260922120000_add_sms_withheld_status).
UPDATE "sms_logs"
   SET "status" = 'WITHHELD'
 WHERE "status" = 'FAILED'
   AND "fail_reason" IN ('SMS_OPTED_OUT', 'PHONE_UNVERIFIED');
