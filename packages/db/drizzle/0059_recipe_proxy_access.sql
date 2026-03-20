ALTER TABLE "jobs" ADD COLUMN "recipe_proxy_mode" text NOT NULL DEFAULT 'off';--> statement-breakpoint
CREATE TABLE "recipe_proxy_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"credential_owner_user_id" text NOT NULL,
	"credential_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"credential_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proxy_mode" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_proxy_access_proxy_mode_check" CHECK ("recipe_proxy_access"."proxy_mode" IN ('one_shot','recurring_auto')),
	CONSTRAINT "recipe_proxy_access_status_check" CHECK ("recipe_proxy_access"."status" IN ('active','revoked'))
);--> statement-breakpoint
ALTER TABLE "recipe_proxy_access" ADD CONSTRAINT "recipe_proxy_access_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_proxy_access_job_id_idx" ON "recipe_proxy_access" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "recipe_proxy_access_status_idx" ON "recipe_proxy_access" USING btree ("status");--> statement-breakpoint
CREATE INDEX "recipe_proxy_access_owner_idx" ON "recipe_proxy_access" USING btree ("credential_owner_user_id");--> statement-breakpoint