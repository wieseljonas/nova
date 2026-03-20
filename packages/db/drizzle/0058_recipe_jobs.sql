ALTER TABLE "jobs" ADD COLUMN "recipe_root" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "recipe_command" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "recipe_timeout_seconds" integer NOT NULL DEFAULT 600;--> statement-breakpoint