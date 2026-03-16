-- Migration reconciliation: fix schema drift from skipped/hand-written migrations
-- 
-- Two columns exist in schema.ts but are missing from the production DB:
-- 1. messages.token_usage (jsonb) - from migration 0035, which was skipped due to
--    duplicate journal timestamps causing drizzle's strict < comparison to fail
-- 2. approvals.approver_ids (text[]) - omitted from hand-written migration 0049
--    (the SQL only created approved_by but schema.ts also defines approver_ids)

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "token_usage" jsonb;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "approver_ids" text[];
