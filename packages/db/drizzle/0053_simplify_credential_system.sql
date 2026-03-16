-- Simplify credential system: drop grants + approval policies, single-table access control

-- Step 1: Migrate existing grants into JSONB arrays before dropping tables
-- Add temporary columns to credentials
ALTER TABLE "credentials" ADD COLUMN "reader_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "writer_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "approval_slack_channel_id" text;--> statement-breakpoint

-- Migrate grant data: readers (permission = 'read')
UPDATE "credentials" 
SET "reader_user_ids" = COALESCE(
  (SELECT jsonb_agg(DISTINCT "grantee_id") 
   FROM "credential_grants" 
   WHERE "credential_grants"."credential_id" = "credentials"."id" 
     AND "credential_grants"."permission" = 'read'
     AND "credential_grants"."revoked_at" IS NULL),
  '[]'::jsonb
);--> statement-breakpoint

-- Migrate grant data: writers (permission = 'write' or 'admin')
UPDATE "credentials" 
SET "writer_user_ids" = COALESCE(
  (SELECT jsonb_agg(DISTINCT "grantee_id") 
   FROM "credential_grants" 
   WHERE "credential_grants"."credential_id" = "credentials"."id" 
     AND "credential_grants"."permission" IN ('write', 'admin')
     AND "credential_grants"."revoked_at" IS NULL),
  '[]'::jsonb
);--> statement-breakpoint

-- Migrate approval channel from approval_policies to credentials
-- Match by credential_name and set approval_slack_channel_id
UPDATE "credentials" 
SET "approval_slack_channel_id" = (
  SELECT "approval_channel" 
  FROM "approval_policies" 
  WHERE "approval_policies"."credential_name" = "credentials"."name" 
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1 
  FROM "approval_policies" 
  WHERE "approval_policies"."credential_name" = "credentials"."name"
);--> statement-breakpoint

-- Step 2: Rename credentials columns
ALTER TABLE "credentials" RENAME COLUMN "name" TO "key";--> statement-breakpoint
ALTER TABLE "credentials" RENAME COLUMN "owner_id" TO "owner_user_id";--> statement-breakpoint

-- Step 3: Drop allowedMethods column
ALTER TABLE "credentials" DROP COLUMN "allowed_methods";--> statement-breakpoint

-- Step 4: Update unique constraint on credentials
ALTER TABLE "credentials" DROP CONSTRAINT "credentials_owner_id_name_unique";--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_owner_user_id_key_unique" UNIQUE("owner_user_id", "key");--> statement-breakpoint

-- Step 5: Update check constraint on credentials
ALTER TABLE "credentials" DROP CONSTRAINT "credentials_name_check";--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_key_check" CHECK ("key" ~ '^[a-z][a-z0-9_]{1,62}$');--> statement-breakpoint

-- Step 6: Drop policyId from approvals
ALTER TABLE "approvals" DROP COLUMN "policy_id";--> statement-breakpoint

-- Step 7: Drop credential_grants table
DROP TABLE "credential_grants";--> statement-breakpoint

-- Step 8: Drop approval_policies table
DROP TABLE "approval_policies";
