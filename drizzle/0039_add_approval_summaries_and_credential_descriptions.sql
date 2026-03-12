-- Add summary column to action_log for LLM-generated approval card summaries
ALTER TABLE "action_log" ADD COLUMN IF NOT EXISTS "summary" jsonb;

-- Add description column to credentials for human-friendly descriptions
ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "description" text;
