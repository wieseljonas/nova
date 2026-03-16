-- Restore credential_owner to approvals table for secure credential lookup
-- The key column is only unique per owner (constraint credentials_owner_user_id_key_unique)
-- Without owner context, credential lookups can return the wrong credential
ALTER TABLE "approvals" ADD COLUMN "credential_owner" text;
