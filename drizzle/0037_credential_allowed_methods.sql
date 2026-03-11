-- Add allowed_methods column to credentials table for per-credential HTTP method permissions
ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "allowed_methods" text[];
--> statement-breakpoint
-- Default to empty array (all methods require approval)
UPDATE "credentials" SET "allowed_methods" = '{}' WHERE "allowed_methods" IS NULL;
