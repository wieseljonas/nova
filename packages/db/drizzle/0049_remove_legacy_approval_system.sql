-- Remove legacy approval system components

-- Drop action_log table
DROP TABLE IF EXISTS "action_log";--> statement-breakpoint

-- Remove legacy columns from jobs table
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "approval_status";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "pending_action_log_id";--> statement-breakpoint

-- Remove legacy constraint
ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_approval_status_check";
