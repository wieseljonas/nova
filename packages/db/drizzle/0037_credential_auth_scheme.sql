-- Add auth_scheme column (idempotent)
ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "auth_scheme" text NOT NULL DEFAULT 'bearer';
--> statement-breakpoint
UPDATE "credentials" SET "auth_scheme" = 'oauth_client' WHERE "type" = 'oauth_client';
--> statement-breakpoint
UPDATE "credentials" SET "auth_scheme" = 'bearer' WHERE "type" = 'token';
--> statement-breakpoint
ALTER TABLE "credentials" DROP CONSTRAINT IF EXISTS "credentials_type_check";
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credentials_auth_scheme_check' AND conrelid = 'credentials'::regclass) THEN
    ALTER TABLE "credentials" ADD CONSTRAINT "credentials_auth_scheme_check" CHECK ("auth_scheme" IN ('bearer','basic','header','query','oauth_client'));
  END IF;
END $$;
