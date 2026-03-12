-- Add LLM-generated summary column to action_log for human-readable approval cards
ALTER TABLE "action_log" ADD COLUMN "summary" jsonb;
