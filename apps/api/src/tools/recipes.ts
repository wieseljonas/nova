import { defineTool } from "../lib/tool.js";
import { z } from "zod";
import { eq, and, desc, isNotNull } from "drizzle-orm";
import type { WebClient } from "@slack/web-api";
import { CronExpressionParser } from "cron-parser";
import { waitUntil } from "@vercel/functions";
import { db } from "../db/client.js";
import { jobs, jobExecutions } from "@aura/db/schema";
import type { FrequencyConfig, ScheduleContext } from "@aura/db/schema";
import { isAdmin } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";
import { parseRelativeTime, formatTimestamp } from "../lib/temporal.js";
import { resolveChannelByName } from "./slack.js";
import { runRecipe } from "../cron/run-recipe.js";
import { getOrCreateSandbox, getSandboxEnvs } from "../lib/sandbox.js";
import {
  clampRecipeTimeoutSeconds,
  resolveRecipeRoot,
} from "../lib/recipes.js";

function getRecipeJobCondition(jobId?: string, name?: string) {
  if (!jobId && !name) return null;
  return and(
    isNotNull(jobs.recipeCommand),
    jobId ? eq(jobs.id, jobId) : eq(jobs.name, name!),
  );
}

export function createRecipeTools(
  client: WebClient,
  context?: ScheduleContext,
) {
  return {
    publish_recipe: defineTool({
      description:
        "Publish (create or update) a deterministic recipe job after validating it with run_command in /mnt/gcs/recipes/<name>/. A recipe runs directly in the sandbox using recipe_command, without LLM interpretation. Use this for repeatable code workflows (syncs, upserts, batch updates).",
      inputSchema: z.object({
        name: z
          .string()
          .regex(
            /^[a-z0-9][a-z0-9_-]{1,62}$/i,
            "Use letters, numbers, _ and -. Start with an alphanumeric character.",
          )
          .describe("Unique recipe name, e.g. close_crm_sync"),
        description: z
          .string()
          .describe("What this recipe does."),
        recipe_root: z
          .string()
          .optional()
          .describe(
            "Root directory for the recipe project. Defaults to /mnt/gcs/recipes/<name>.",
          ),
        recipe_command: z
          .string()
          .describe(
            "Command to run inside recipe_root, e.g. 'npm run sync', 'python main.py', 'bash run.sh'.",
          ),
        execute_in: z
          .string()
          .optional()
          .describe(
            "When to first execute. Relative time: '30 minutes', '2 hours', '1 day', 'tomorrow'. Required for one-shots.",
          ),
        recurring: z
          .string()
          .optional()
          .describe(
            "Cron expression for recurring recipes, e.g. '0 4 * * *'.",
          ),
        channel_name: z
          .string()
          .optional()
          .describe("Channel to post run summaries in."),
        timezone: z
          .string()
          .default("UTC")
          .describe("IANA timezone for recurring schedules."),
        priority: z
          .enum(["high", "normal", "low"])
          .default("normal"),
        timeout_seconds: z
          .number()
          .min(10)
          .max(750)
          .default(600)
          .describe("Recipe command timeout in seconds."),
        min_interval_hours: z.number().optional(),
        max_per_day: z.number().optional(),
      }),
      execute: async ({
        name,
        description,
        recipe_root,
        recipe_command,
        execute_in,
        recurring,
        channel_name,
        timezone,
        priority,
        timeout_seconds,
        min_interval_hours,
        max_per_day,
      }) => {
        if (!isAdmin(context?.userId)) {
          return { ok: false, error: "Only admins can publish recipes." };
        }

        try {
          const recipeCommand = recipe_command.trim();
          if (!recipeCommand) {
            return { ok: false, error: "recipe_command cannot be empty." };
          }

          const recipeRoot = resolveRecipeRoot(name, recipe_root);
          const timeoutSeconds = clampRecipeTimeoutSeconds(timeout_seconds);

          let channelId: string | null = null;
          let channelLabel = "DM-routed";
          if (channel_name) {
            const channel = await resolveChannelByName(client, channel_name);
            if (!channel) {
              return { ok: false, error: `Could not find channel "${channel_name}".` };
            }
            channelId = channel.id;
            channelLabel = `#${channel.name}`;
          }

          if (recurring) {
            try {
              CronExpressionParser.parse(recurring);
            } catch {
              return {
                ok: false,
                error: `Invalid cron expression "${recurring}". Use standard 5-field syntax.`,
              };
            }
          }

          let executeAt: Date | null = null;
          if (execute_in) {
            const delayMs = parseRelativeTime(execute_in);
            if (!delayMs) {
              return {
                ok: false,
                error: `Could not parse execute_in: "${execute_in}".`,
              };
            }
            executeAt = new Date(Date.now() + delayMs);
          } else if (recurring) {
            const interval = CronExpressionParser.parse(recurring, {
              currentDate: new Date(),
              tz: timezone,
            });
            executeAt = interval.next().toDate();
          }

          if (!executeAt && !recurring) {
            return {
              ok: false,
              error: "One-shot recipes require execute_in. Recurring recipes require recurring cron.",
            };
          }

          const sandbox = await getOrCreateSandbox();
          const envs = await getSandboxEnvs();
          const rootCheck = await sandbox.commands.run(`test -d "${recipeRoot}" && echo ok || echo missing`, {
            timeoutMs: 10_000,
            envs,
          });
          if (rootCheck.stdout?.trim() !== "ok") {
            return {
              ok: false,
              error: `recipe_root does not exist in sandbox: ${recipeRoot}. Develop with run_command first.`,
            };
          }

          const frequencyConfig: FrequencyConfig | null =
            recurring && (min_interval_hours != null || max_per_day != null)
              ? {
                  ...(min_interval_hours != null && { minIntervalHours: min_interval_hours }),
                  ...(max_per_day != null && { maxPerDay: max_per_day }),
                }
              : null;

          const requestedBy = context?.userId || "aura";
          const updateSet: Record<string, unknown> = {
            description,
            updatedAt: new Date(),
            status: "pending",
            enabled: 1,
            retries: 0,
            recipeRoot,
            recipeCommand,
            recipeTimeoutSeconds: timeoutSeconds,
            playbook: null,
          };
          if (recurring !== undefined) updateSet.cronSchedule = recurring || null;
          if (channel_name !== undefined) updateSet.channelId = channelId;
          updateSet.threadTs = !recurring ? (context?.threadTs || null) : null;
          updateSet.frequencyConfig = frequencyConfig;
          if (executeAt) updateSet.executeAt = executeAt;
          updateSet.timezone = timezone;
          updateSet.priority = priority;

          await db
            .insert(jobs)
            .values({
              name,
              description,
              playbook: null,
              cronSchedule: recurring || null,
              frequencyConfig,
              channelId: channelId || context?.channelId || "",
              threadTs: !recurring ? (context?.threadTs || null) : null,
              executeAt,
              requestedBy,
              timezone,
              priority,
              recipeRoot,
              recipeCommand,
              recipeTimeoutSeconds: timeoutSeconds,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: jobs.name,
              set: updateSet,
            });

          const timeStr = executeAt?.toISOString() ?? "next cron window";
          return {
            ok: true,
            message:
              `Recipe "${name}" published. First execution: ${timeStr}.` +
              (channelId ? ` Posts to ${channelLabel}.` : ""),
            name,
            recipe_root: recipeRoot,
            recipe_command: recipeCommand,
            execute_at: timeStr,
          };
        } catch (error: any) {
          logger.error("publish_recipe failed", { error: error.message });
          return { ok: false, error: `Failed to publish recipe: ${error.message}` };
        }
      },
      slack: {
        status: "Publishing recipe...",
        detail: (i) => i.name,
        output: (r) => (r.ok === false ? r.error : `Published '${r.name || "recipe"}'`),
      },
    }),

    list_recipes: defineTool({
      description:
        "List recipe jobs (deterministic code execution) and their schedule/status.",
      inputSchema: z.object({
        status: z
          .enum(["pending", "running", "completed", "failed", "cancelled"])
          .optional()
          .describe("Optional status filter."),
        limit: z.number().min(1).max(50).default(20),
      }),
      execute: async ({ status, limit }) => {
        try {
          const conditions = [isNotNull(jobs.recipeCommand)];
          if (status) conditions.push(eq(jobs.status, status));

          const rows = await db
            .select()
            .from(jobs)
            .where(and(...conditions))
            .orderBy(desc(jobs.createdAt))
            .limit(limit);

          const tz = context?.timezone;
          const recipes = rows.map((j) => ({
            id: j.id,
            name: j.name,
            description: j.description.substring(0, 120),
            recipe_root: j.recipeRoot,
            recipe_command: j.recipeCommand,
            recipe_timeout_seconds: j.recipeTimeoutSeconds,
            status: j.status,
            enabled: j.enabled === 1,
            cron_schedule: j.cronSchedule,
            execute_at: formatTimestamp(j.executeAt, tz) || null,
            last_executed_at: formatTimestamp(j.lastExecutedAt, tz) || null,
            last_result: j.lastResult ? j.lastResult.substring(0, 200) : null,
            execution_count: j.executionCount,
          }));

          return { ok: true, recipes, count: recipes.length };
        } catch (error: any) {
          logger.error("list_recipes failed", { error: error.message });
          return { ok: false, error: `Failed to list recipes: ${error.message}` };
        }
      },
      slack: {
        status: "Listing recipes...",
        output: (r) => (r.ok === false ? r.error : `${r.count ?? 0} recipes`),
      },
    }),

    read_recipe: defineTool({
      description:
        "Read one recipe's metadata and recent execution states for debugging.",
      inputSchema: z.object({
        recipe_id: z.string().optional(),
        name: z.string().optional(),
        trace_limit: z.number().min(1).max(10).default(3),
      }),
      execute: async ({ recipe_id, name, trace_limit }) => {
        try {
          const condition = getRecipeJobCondition(recipe_id, name);
          if (!condition) {
            return { ok: false, error: "Provide recipe_id or name." };
          }

          const rows = await db.select().from(jobs).where(condition).limit(1);
          if (rows.length === 0) {
            return { ok: false, error: "Recipe not found." };
          }
          const recipe = rows[0];

          const executions = await db
            .select()
            .from(jobExecutions)
            .where(eq(jobExecutions.jobId, recipe.id))
            .orderBy(desc(jobExecutions.startedAt))
            .limit(trace_limit);

          return {
            ok: true,
            recipe: {
              id: recipe.id,
              name: recipe.name,
              description: recipe.description,
              recipe_root: recipe.recipeRoot,
              recipe_command: recipe.recipeCommand,
              recipe_timeout_seconds: recipe.recipeTimeoutSeconds,
              status: recipe.status,
              enabled: recipe.enabled === 1,
              cron_schedule: recipe.cronSchedule,
              execute_at: recipe.executeAt?.toISOString() || null,
              last_executed_at: recipe.lastExecutedAt?.toISOString() || null,
              execution_count: recipe.executionCount,
            },
            executions: executions.map((e) => ({
              id: e.id,
              status: e.status,
              trigger: e.trigger,
              startedAt: e.startedAt?.toISOString(),
              finishedAt: e.finishedAt?.toISOString(),
              summary: e.summary,
              error: e.error,
              steps: e.steps,
            })),
          };
        } catch (error: any) {
          logger.error("read_recipe failed", { error: error.message });
          return { ok: false, error: `Failed to read recipe: ${error.message}` };
        }
      },
      slack: {
        status: "Reading recipe...",
        detail: (i) => i.name ?? i.recipe_id,
        output: (r) => (r.ok === false ? r.error : "Recipe loaded"),
      },
    }),

    run_recipe_now: defineTool({
      description:
        "Trigger immediate recipe execution (dispatch semantics). Does not wait for heartbeat.",
      inputSchema: z.object({
        recipe_id: z.string().optional(),
        name: z.string().optional(),
      }),
      execute: async ({ recipe_id, name }) => {
        if (!isAdmin(context?.userId)) {
          return { ok: false, error: "Only admins can run recipes immediately." };
        }

        try {
          const condition = getRecipeJobCondition(recipe_id, name);
          if (!condition) return { ok: false, error: "Provide recipe_id or name." };

          const rows = await db.select().from(jobs).where(condition).limit(1);
          if (rows.length === 0) return { ok: false, error: "Recipe not found." };
          const recipe = rows[0];

          if (recipe.enabled !== 1) {
            return {
              ok: false,
              error: `Recipe "${recipe.name}" is disabled. Enable/publish it first.`,
            };
          }
          if (recipe.status === "running") {
            return {
              ok: false,
              error: `Recipe "${recipe.name}" is already running.`,
            };
          }

          const [job] = await db
            .update(jobs)
            .set({
              status: "pending",
              executeAt: new Date(),
              retries: 0,
              updatedAt: new Date(),
            })
            .where(eq(jobs.id, recipe.id))
            .returning();

          waitUntil(
            (async () => {
              try {
                await runRecipe(job, "dispatch");
              } catch (err: any) {
                logger.error("run_recipe_now failed", {
                  jobId: job.id,
                  error: err.message,
                });
              }
            })(),
          );

          return {
            ok: true,
            recipe_id: recipe.id,
            name: recipe.name,
            message: `Recipe "${recipe.name}" dispatched for immediate execution.`,
          };
        } catch (error: any) {
          logger.error("run_recipe_now failed", { error: error.message });
          return { ok: false, error: `Failed to run recipe now: ${error.message}` };
        }
      },
      slack: {
        status: "Running recipe...",
        detail: (i) => i.name ?? i.recipe_id,
        output: (r) => (r.ok === false ? r.error : `Dispatched '${r.name || "recipe"}'`),
      },
    }),

    disable_recipe: defineTool({
      description:
        "Disable a recipe to stop future scheduled executions while preserving definition/history.",
      inputSchema: z.object({
        recipe_id: z.string().optional(),
        name: z.string().optional(),
      }),
      execute: async ({ recipe_id, name }) => {
        if (!isAdmin(context?.userId)) {
          return { ok: false, error: "Only admins can disable recipes." };
        }

        try {
          const condition = getRecipeJobCondition(recipe_id, name);
          if (!condition) return { ok: false, error: "Provide recipe_id or name." };

          const rows = await db.select().from(jobs).where(condition).limit(1);
          if (rows.length === 0) return { ok: false, error: "Recipe not found." };
          const recipe = rows[0];

          await db
            .update(jobs)
            .set({ enabled: 0, updatedAt: new Date() })
            .where(eq(jobs.id, recipe.id));

          return {
            ok: true,
            recipe_id: recipe.id,
            name: recipe.name,
            message: `Recipe "${recipe.name}" disabled.`,
          };
        } catch (error: any) {
          logger.error("disable_recipe failed", { error: error.message });
          return { ok: false, error: `Failed to disable recipe: ${error.message}` };
        }
      },
      slack: {
        status: "Disabling recipe...",
        detail: (i) => i.name ?? i.recipe_id,
        output: (r) => (r.ok === false ? r.error : `Disabled '${r.name || "recipe"}'`),
      },
    }),

    stop_recipe_run: defineTool({
      description:
        "Stop an in-flight recipe execution immediately. This interrupts the currently running command. For recurring recipes, future schedule remains enabled.",
      inputSchema: z.object({
        recipe_id: z.string().optional(),
        name: z.string().optional(),
      }),
      execute: async ({ recipe_id, name }) => {
        if (!isAdmin(context?.userId)) {
          return { ok: false, error: "Only admins can stop running recipes." };
        }

        try {
          const condition = getRecipeJobCondition(recipe_id, name);
          if (!condition) return { ok: false, error: "Provide recipe_id or name." };

          const rows = await db.select().from(jobs).where(condition).limit(1);
          if (rows.length === 0) return { ok: false, error: "Recipe not found." };
          const recipe = rows[0];
          if (recipe.status !== "running") {
            return {
              ok: false,
              error: `Recipe "${recipe.name}" is not currently running.`,
            };
          }

          const now = new Date();
          if (recipe.cronSchedule || recipe.frequencyConfig) {
            await db
              .update(jobs)
              .set({
                status: "pending",
                executeAt: null,
                retries: 0,
                lastExecutedAt: now,
                lastResult: "Recipe run stopped by user",
                updatedAt: now,
              })
              .where(eq(jobs.id, recipe.id));
          } else {
            await db
              .update(jobs)
              .set({
                status: "cancelled",
                result: "Recipe run stopped by user",
                updatedAt: now,
              })
              .where(eq(jobs.id, recipe.id));
          }

          await db
            .update(jobExecutions)
            .set({
              status: "failed",
              finishedAt: now,
              error: "Execution stopped by stop_recipe_run",
            })
            .where(
              and(
                eq(jobExecutions.jobId, recipe.id),
                eq(jobExecutions.status, "running"),
              ),
            );

          let killResultSummary = "stop requested";
          try {
            const sandbox = await getOrCreateSandbox();
            const envs = await getSandboxEnvs();
            const pidFile = `/tmp/recipe-job-${recipe.id}.pid`;
            const killResult = await sandbox.commands.run(
              `bash -lc 'if [ -f "${pidFile}" ]; then PID=$(cat "${pidFile}"); kill -TERM "$PID" 2>/dev/null || true; sleep 1; kill -KILL "$PID" 2>/dev/null || true; echo killed; else echo pid_not_found; fi'`,
              { timeoutMs: 10_000, envs },
            );
            killResultSummary = (killResult.stdout || "").trim() || "stop requested";
          } catch (killErr: any) {
            logger.warn("stop_recipe_run: failed to kill process", {
              recipeId: recipe.id,
              error: killErr.message,
            });
          }

          return {
            ok: true,
            recipe_id: recipe.id,
            name: recipe.name,
            message: `Stop requested for "${recipe.name}" (${killResultSummary}).`,
          };
        } catch (error: any) {
          logger.error("stop_recipe_run failed", { error: error.message });
          return { ok: false, error: `Failed to stop recipe run: ${error.message}` };
        }
      },
      slack: {
        status: "Stopping recipe run...",
        detail: (i) => i.name ?? i.recipe_id,
        output: (r) => (r.ok === false ? r.error : "Stop requested"),
      },
    }),
  };
}

