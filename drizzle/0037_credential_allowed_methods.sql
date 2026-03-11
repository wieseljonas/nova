-- Add allowed_methods column to credentials table for per-credential HTTP method permissions
ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "allowed_methods" text[];
--> statement-breakpoint
-- Default to {GET} (GET is always pre-approved, matching previous behavior)
UPDATE "credentials" SET "allowed_methods" = '{GET}' WHERE "allowed_methods" IS NULL;
