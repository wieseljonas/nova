-- Remove credential snapshot from approvals, use live lookup instead

-- Rename credentialName to credentialKey
ALTER TABLE "approvals" RENAME COLUMN "credential_name" TO "credential_key";--> statement-breakpoint

-- Drop credentialOwner column (no longer needed, look up by key)
ALTER TABLE "approvals" DROP COLUMN "credential_owner";--> statement-breakpoint

-- Drop approverIds column (no longer needed, look up from credential)
ALTER TABLE "approvals" DROP COLUMN "approver_ids";
