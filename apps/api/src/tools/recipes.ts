import { defineTool } from "../lib/tool.js";
import { z } from "zod";
import { eq, and, desc, isNotNull, inArray } from "drizzle-orm";
import type { WebClient } from "@slack/web-api";
import { CronExpressionParser } from "cron-parser";
import { db } from "../db/client.js";
import {
  jobs,
  jobExecutions,
  credentials,
  recipeProxyGrants,
} from "@aura/db/schema";
import type { FrequencyConfig, ScheduleContext } from "@aura/db/schema";
import { isAdmin } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";
import { parseRelativeTime, formatTimestamp } from "../lib/temporal.js";
import { resolveChannelByName } from "./slack.js";
import { runRecipe, parseRunningRecipeResult } from "../cron/run-recipe.js";
import { getOrCreateSandbox, getSandboxEnvs } from "../lib/sandbox.js";
import {
  clampRecipeTimeoutSeconds,
  resolveRecipeRoot,
} from "../lib/recipes.js";
import { shellQuote } from "../lib/shell-utils.js";

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
        "Publish (create or update) a deterministic recipe job after validating it with run_command in /mnt/gcs/recipes/<name>/. A recipe runs directly in the sandbox using recipe_command, without LLM interpretation. Use this for repeatable code workflows (syncs, upserts, batch updates). Proxy credential flow: set proxy_mode ('off', 'one_shot', 'recurring_auto') and proxy_credential_keys when proxy_mode is not 'off'.",
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
        proxy_mode: z
          .enum(["off", "one_shot", "recurring_auto"])
          .default("off")
          .describe(
            "Proxy mode: off (no proxy credential), one_shot (manual/one-off runs), recurring_auto (allow recurring runs to mint short-lived proxy tokens automatically).",
          ),
        proxy_credential_keys: z
          .array(
            z
              .string()
              .regex(
                /^[a-z][a-z0-9_]{1,62}$/,
                "Use lowercase letters, numbers, and _. Start with a letter.",
              ),
          )
          .default([])
          .describe(
            "Credential keys allowed for proxy calls when proxy_mode is not 'off'.",
          ),
        proxy_credential_owner: z
          .string()
          .optional()
          .describe(
            "Slack user ID of the credential owner. Defaults to the publishing user. All keys must belong to this owner.",
          ),
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
        proxy_mode,
        proxy_credential_keys,
        proxy_credential_owner,
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

          const credentialKeys = [
            ...new Set(
              (proxy_credential_keys || []).map((k) => k.trim()).filter(Boolean),
            ),
          ];
          if (proxy_mode === "off" && credentialKeys.length > 0) {
            return {
              ok: false,
              error:
                "proxy_credential_keys were provided but proxy_mode is 'off'. Either remove keys or set proxy_mode.",
            };
          }
          if (proxy_mode !== "off" && credentialKeys.length === 0) {
            return {
              ok: false,
              error:
                "proxy_credential_keys is required when proxy_mode is not 'off'.",
            };
          }
          if (proxy_mode === "one_shot" && recurring) {
            return {
              ok: false,
              error:
                "Recurring recipes cannot use proxy_mode='one_shot'. Use proxy_mode='recurring_auto'.",
            };
          }

          const credentialOwner =
            proxy_mode === "off"
              ? null
              : proxy_credential_owner || context?.userId || null;
          if (proxy_mode !== "off" && !credentialOwner) {
            return {
              ok: false,
              error:
                "proxy_credential_owner is required when proxy_mode is enabled outside user context.",
            };
          }

          let proxyCredentials:
            | Array<{ id: string; key: string; owner: string }>
            | null = null;
          if (proxy_mode !== "off") {
            const credRows = await db
              .select({
                id: credentials.id,
                key: credentials.key,
              })
              .from(credentials)
              .where(
                and(
                  eq(credentials.ownerUserId, credentialOwner!),
                  inArray(credentials.key, credentialKeys),
                ),
              );
            const byKey = new Map(credRows.map((r) => [r.key, r]));
            const missingKeys = credentialKeys.filter((key) => !byKey.has(key));
            if (missingKeys.length > 0) {
              return {
                ok: false,
                error:
                  `Credential(s) not found for owner "${credentialOwner}": ${missingKeys.join(", ")}.`,
              };
            }
            proxyCredentials = credentialKeys.map((key) => ({
              id: byKey.get(key)!.id,
              key,
              owner: credentialOwner!,
            }));
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
            recipeProxyMode: proxy_mode,
            requiredCredentialIds: proxyCredentials
              ? proxyCredentials.map((c) => c.id)
              : [],
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
              recipeProxyMode: proxy_mode,
              requiredCredentialIds: proxyCredentials
                ? proxyCredentials.map((c) => c.id)
                : [],
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: jobs.name,
              set: updateSet,
            });

          const currentJobRows = await db
            .select({ id: jobs.id })
            .from(jobs)
            .where(eq(jobs.name, name))
            .limit(1);
          const currentJob = currentJobRows[0];
          if (!currentJob) {
            return { ok: false, error: "Recipe created but could not reload job." };
          }

          if (proxy_mode === "off") {
            await db
              .update(recipeProxyGrants)
              .set({
                status: "revoked",
                updatedAt: new Date(),
              })
              .where(eq(recipeProxyGrants.jobId, currentJob.id));
          } else {
            const approver = context?.userId || "aura";
            await db
              .insert(recipeProxyGrants)
              .values({
                jobId: currentJob.id,
                credentialOwnerUserId: credentialOwner!,
                credentialIds: proxyCredentials!.map((c) => c.id),
                credentialKeys: proxyCredentials!.map((c) => c.key),
                proxyMode: proxy_mode,
                status: "active",
                approvedBy: approver,
                approvedAt: new Date(),
                updatedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: recipeProxyGrants.jobId,
                set: {
                  credentialOwnerUserId: credentialOwner!,
                  credentialIds: proxyCredentials!.map((c) => c.id),
                  credentialKeys: proxyCredentials!.map((c) => c.key),
                  proxyMode: proxy_mode,
                  status: "active",
                  approvedBy: approver,
                  approvedAt: new Date(),
                  updatedAt: new Date(),
                },
              });
          }

          const timeStr = executeAt?.toISOString() ?? "next cron window";
          const credentialText = proxyCredentials
            ? recurring
              ? ` Proxy grant approved (${proxy_mode}) for ${proxyCredentials.length} credential(s): ${proxyCredentials.map((c) => c.key).join(", ")}. Recurring runs will mint short-lived NOVA_PROXY_TOKEN automatically.`
              : ` Proxy grant approved (${proxy_mode}) for credential(s): ${proxyCredentials.map((c) => c.key).join(", ")}.`
            : "";
          return {
            ok: true,
            message:
              `Recipe "${name}" published. First execution: ${timeStr}.` +
              (channelId ? ` Posts to ${channelLabel}.` : "") +
              credentialText,
            name,
            recipe_root: recipeRoot,
            recipe_command: recipeCommand,
            execute_at: timeStr,
            proxy_mode,
            proxy_credentials: proxyCredentials
              ? proxyCredentials.map((c) => ({ key: c.key, owner: c.owner }))
              : null,
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
            proxy_mode: j.recipeProxyMode,
            proxy_credential_count: j.requiredCredentialIds?.length ?? 0,
            uses_proxy_credentials: (j.requiredCredentialIds?.length ?? 0) > 0,
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

          const grantRows = await db
            .select({
              status: recipeProxyGrants.status,
              proxyMode: recipeProxyGrants.proxyMode,
              credentialOwnerUserId: recipeProxyGrants.credentialOwnerUserId,
              credentialKeys: recipeProxyGrants.credentialKeys,
              approvedBy: recipeProxyGrants.approvedBy,
              approvedAt: recipeProxyGrants.approvedAt,
              lastUsedAt: recipeProxyGrants.lastUsedAt,
              useCount: recipeProxyGrants.useCount,
            })
            .from(recipeProxyGrants)
            .where(eq(recipeProxyGrants.jobId, recipe.id))
            .limit(1);
          const grant = grantRows[0];

          return {
            ok: true,
            recipe: {
              id: recipe.id,
              name: recipe.name,
              description: recipe.description,
              recipe_root: recipe.recipeRoot,
              recipe_command: recipe.recipeCommand,
              recipe_timeout_seconds: recipe.recipeTimeoutSeconds,
              proxy_mode: recipe.recipeProxyMode,
              proxy_credential_count: recipe.requiredCredentialIds?.length ?? 0,
              uses_proxy_credentials:
                (recipe.requiredCredentialIds?.length ?? 0) > 0,
              status: recipe.status,
              enabled: recipe.enabled === 1,
              cron_schedule: recipe.cronSchedule,
              execute_at: recipe.executeAt?.toISOString() || null,
              last_executed_at: recipe.lastExecutedAt?.toISOString() || null,
              execution_count: recipe.executionCount,
            },
            proxy_grant: grant
              ? {
                  status: grant.status,
                  proxy_mode: grant.proxyMode,
                  credential_owner: grant.credentialOwnerUserId,
                  credential_keys: grant.credentialKeys,
                  approved_by: grant.approvedBy,
                  approved_at: grant.approvedAt?.toISOString() || null,
                  last_used_at: grant.lastUsedAt?.toISOString() || null,
                  use_count: grant.useCount,
                }
              : null,
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

          await runRecipe(job, "dispatch");

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

          const state = parseRunningRecipeResult(recipe.result);
          if (!state) {
            return {
              ok: false,
              error:
                `Recipe "${recipe.name}" is running but has no runtime PID metadata. ` +
                "Wait for heartbeat recovery or relaunch the run.",
            };
          }
          if (!/^[0-9]+$/.test(state.pid)) {
            return {
              ok: false,
              error: `Recipe "${recipe.name}" has an invalid PID in runtime metadata.`,
            };
          }

          const now = new Date();
          const stopRequestedBy = context?.userId || "aura";
          const updatedState = {
            ...state,
            stopRequestedBy,
            stopRequestedAt: now.toISOString(),
          };

          await db
            .update(jobs)
            .set({
              result: JSON.stringify(updatedState),
              updatedAt: now,
            })
            .where(eq(jobs.id, recipe.id));

          let killResultSummary = `pid ${state.pid}`;
          try {
            const sandbox = await getOrCreateSandbox();
            const envs = await getSandboxEnvs();
            const stopMarker = `[nova] stop_recipe_run requested by ${stopRequestedBy}`;
            const stopCmd = [
              `kill -TERM ${state.pid} 2>/dev/null || true`,
              "sleep 1",
              `kill -KILL ${state.pid} 2>/dev/null || true`,
              `echo 143 > ${shellQuote(state.exitFile)}`,
              `echo ${shellQuote(stopMarker)} >> ${shellQuote(state.stderrFile)}`,
              "echo stop_requested",
            ].join("; ");
            const killResult = await sandbox.commands.run(
              `bash -lc ${shellQuote(stopCmd)}`,
              { timeoutMs: 10_000, envs },
            );
            killResultSummary = (killResult.stdout || "").trim() || "stop requested";
          } catch (killErr: any) {
            logger.warn("stop_recipe_run: failed to kill process", {
              recipeId: recipe.id,
              error: killErr.message,
            });
            return {
              ok: false,
              error: `Failed to stop recipe "${recipe.name}": ${killErr.message}`,
            };
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

