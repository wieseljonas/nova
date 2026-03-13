-- Add new columns to approval_policies
ALTER TABLE "approval_policies" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD COLUMN "action" text DEFAULT 'require_approval' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD COLUMN "approval_mode" text DEFAULT 'any_one' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint

-- Migrate existing data from riskTier to action
UPDATE "approval_policies" SET "action" = CASE
  WHEN "risk_tier" = 'read' THEN 'auto_approve'
  ELSE 'require_approval'
END;--> statement-breakpoint

-- Drop old column and constraint
ALTER TABLE "approval_policies" DROP CONSTRAINT IF EXISTS "approval_policies_risk_tier_check";--> statement-breakpoint
ALTER TABLE "approval_policies" DROP COLUMN IF EXISTS "risk_tier";--> statement-breakpoint

-- Add new constraints
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_action_check" CHECK ("action" IN ('require_approval','auto_approve','deny'));--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_approval_mode_check" CHECK ("approval_mode" IN ('any_one','all_must'));--> statement-breakpoint

-- Seed default policies
INSERT INTO "approval_policies" ("name", "priority", "http_methods", "action", "approval_mode", "created_by") VALUES
  ('Default: auto-approve reads', 0, '{GET}', 'auto_approve', 'any_one', 'system'),
  ('Default: require approval for writes', 1, '{POST,PUT,PATCH,DELETE}', 'require_approval', 'any_one', 'system')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Create approvals table
CREATE TABLE IF NOT EXISTS "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"credential_name" text,
	"url_pattern" text,
	"http_method" text,
	"total_items" integer DEFAULT 1 NOT NULL,
	"completed_items" integer DEFAULT 0 NOT NULL,
	"failed_items" integer DEFAULT 0 NOT NULL,
	"policy_id" uuid,
	"requested_by" text DEFAULT 'nova' NOT NULL,
	"requested_in_channel" text,
	"approved_by" text[],
	"approval_mode" text DEFAULT 'any_one' NOT NULL,
	"required_approvals" integer DEFAULT 1 NOT NULL,
	"job_id" uuid,
	"slack_message_ts" text,
	"slack_channel" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_status_check" CHECK ("status" IN ('pending','approved','rejected','executing','completed','failed')),
	CONSTRAINT "approvals_approval_mode_check" CHECK ("approval_mode" IN ('any_one','all_must'))
);--> statement-breakpoint

-- Create approval_items table
CREATE TABLE IF NOT EXISTS "approval_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"approval_id" uuid NOT NULL,
	"sequence_num" integer NOT NULL,
	"method" text NOT NULL,
	"url" text NOT NULL,
	"body" jsonb,
	"headers" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"error" text,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_items_status_check" CHECK ("status" IN ('pending','executing','succeeded','failed','skipped'))
);--> statement-breakpoint

-- Add foreign keys
DO $$ BEGIN
 ALTER TABLE "approvals" ADD CONSTRAINT "approvals_policy_id_approval_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."approval_policies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "approvals" ADD CONSTRAINT "approvals_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "approval_items" ADD CONSTRAINT "approval_items_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- Create indexes
CREATE INDEX IF NOT EXISTS "approvals_status_idx" ON "approvals" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_job_id_idx" ON "approvals" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_items_approval_id_idx" ON "approval_items" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_items_status_idx" ON "approval_items" USING btree ("status");
