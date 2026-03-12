ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "allowed_methods" text[];
--> statement-breakpoint
UPDATE "credentials" SET "allowed_methods" = '{GET}' WHERE "allowed_methods" IS NULL;
