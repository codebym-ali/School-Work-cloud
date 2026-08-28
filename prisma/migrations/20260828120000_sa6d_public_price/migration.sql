-- SA6d — the public "list" per-student price shown on the marketing site, editable from the vendor
-- console. A single vendor-wide value on platform_settings; distinct from schools.price_per_student
-- (the rate each individual school is billed). Defaults to 20 so the site always has a figure to show.
ALTER TABLE "platform_settings" ADD COLUMN "public_price_per_student" DECIMAL(12,2) NOT NULL DEFAULT 20;
