ALTER TABLE "action_log" ADD COLUMN IF NOT EXISTS "conversation_state" jsonb;
--> statement-breakpoint
ALTER TABLE "action_log" ADD COLUMN IF NOT EXISTS "approval_message_ts" text;
--> statement-breakpoint
ALTER TABLE "action_log" ADD COLUMN IF NOT EXISTS "approval_channel_id" text;
