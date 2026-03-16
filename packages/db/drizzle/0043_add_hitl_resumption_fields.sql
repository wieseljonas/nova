-- Add HITL (Human-in-the-Loop) resumption fields to action_log table
ALTER TABLE "action_log" ADD COLUMN "conversation_state" jsonb;
--> statement-breakpoint
ALTER TABLE "action_log" ADD COLUMN "approval_message_ts" text;
--> statement-breakpoint
ALTER TABLE "action_log" ADD COLUMN "approval_channel_id" text;
