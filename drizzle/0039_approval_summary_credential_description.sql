-- Add LLM-generated summary column to action_log for human-readable approval cards
ALTER TABLE "action_log" ADD COLUMN "summary" jsonb;

-- Add human-readable description column to credentials
ALTER TABLE "credentials" ADD COLUMN "description" text;
