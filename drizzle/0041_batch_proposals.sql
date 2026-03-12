-- batch_proposals: track bulk operation proposals requiring human approval
CREATE TABLE IF NOT EXISTS "batch_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "action_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending_review',
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "approved_by" text,
  "approved_at" timestamp with time zone,
  "executed_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "approval_message_ts" text,
  "approval_channel_id" text,
  "credential_name" text,
  "credential_owner" text,
  "progress_current" integer NOT NULL DEFAULT 0,
  "progress_total" integer NOT NULL,
  "summary_title" text,
  "summary_details" text,
  "context" jsonb,
  CONSTRAINT "batch_proposals_status_check" CHECK ("status" IN ('pending_review', 'approved', 'rejected', 'executing', 'completed', 'failed', 'partially_completed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "batch_proposals_status_idx" ON "batch_proposals" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "batch_proposals_created_by_idx" ON "batch_proposals" USING btree ("created_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "batch_proposals_created_at_idx" ON "batch_proposals" USING btree ("created_at");
--> statement-breakpoint

-- batch_items: individual items within a batch proposal
CREATE TABLE IF NOT EXISTS "batch_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "batch_id" uuid NOT NULL REFERENCES "batch_proposals"("id") ON DELETE CASCADE,
  "index" integer NOT NULL,
  "method" text NOT NULL,
  "url" text NOT NULL,
  "body" jsonb,
  "headers" jsonb,
  "status" text NOT NULL DEFAULT 'pending',
  "result" jsonb,
  "executed_at" timestamp with time zone,
  "error" text,
  CONSTRAINT "batch_items_status_check" CHECK ("status" IN ('pending', 'executing', 'success', 'failed', 'skipped')),
  CONSTRAINT "batch_items_method_check" CHECK ("method" IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "batch_items_batch_id_idx" ON "batch_items" USING btree ("batch_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "batch_items_status_idx" ON "batch_items" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "batch_items_batch_id_index_unique" ON "batch_items" USING btree ("batch_id", "index");
