-- Add summary column to action_log for LLM-generated approval summaries
ALTER TABLE "action_log" ADD COLUMN "summary" jsonb;

-- Add description column to credentials for user-provided credential descriptions
ALTER TABLE "credentials" ADD COLUMN "description" text;
