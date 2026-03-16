-- Remove unused approval mode columns (single-step approvals only)

ALTER TABLE "approvals" DROP CONSTRAINT IF EXISTS "approvals_approval_mode_check";--> statement-breakpoint
ALTER TABLE "approvals" DROP COLUMN IF EXISTS "approval_mode";--> statement-breakpoint
ALTER TABLE "approvals" DROP COLUMN IF EXISTS "required_approvals";--> statement-breakpoint
