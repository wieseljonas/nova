-- Add summary jsonb column to action_log for LLM-generated approval summaries
ALTER TABLE "action_log" ADD COLUMN IF NOT EXISTS "summary" jsonb;

-- Add description text column to credentials for human-readable context
ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "description" text;
