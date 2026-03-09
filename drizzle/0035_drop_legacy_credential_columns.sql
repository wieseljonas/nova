-- Drop legacy columns after runCredentialMigration() has folded token_url into encrypted blobs.
-- Safe to run only after the JS runtime migration has completed at least once.
ALTER TABLE "credentials" DROP COLUMN IF EXISTS "type";
--> statement-breakpoint
ALTER TABLE "credentials" DROP COLUMN IF EXISTS "token_url";
