-- Add display_name column to credentials for human-friendly labels
ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "display_name" text;
