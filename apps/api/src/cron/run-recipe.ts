import { WebClient } from "@slack/web-api";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { jobs, jobExecutions } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { safePostMessage } from "../lib/slack-messaging.js";
import {
  getOrCreateSandbox,
  getSandboxEnvs,
  truncateOutput,
} from "../lib/sandbox.js";
import {
  clampRecipeTimeoutSeconds,
  resolveRecipeRoot,
} from "../lib/recipes.js";
import { MAX_RETRIES } from "./execute-job.js";

const botToken = process.env.SLACK_BOT_TOKEN || "";
const slackClient = new WebClient(botToken);
const RETRY_DELAY_MS = 10 * 60 * 1000;

function isRecurring(job: typeof jobs.$inferSelect): boolean {
  return !!job.cronSchedule || !!job.frequencyConfig;
}

async function isStillRunning(jobId: string): Promise<boolean> {
  const rows = await db
    .select({ status: jobs.status })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  return rows[0]?.status === "running";
}

export async function runRecipe(
  job: typeof jobs.$inferSelect,
  trigger: "heartbeat" | "dispatch" = "heartbeat",
): Promise<boolean> {
  const jobId = job.id;

  const claimed = await db
    .update(jobs)
    .set({ status: "running", updatedAt: new Date() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "pending")))
    .returning({ id: jobs.id });

  if (claimed.length === 0) {
    logger.info("runRecipe: job already claimed, skipping", {
      jobId,
      jobName: job.name,
    });
    return false;
  }

  const [execution] = await db
    .insert(jobExecutions)
    .values({
      jobId,
      status: "running",
      trigger,
      callbackChannel: job.channelId || null,
      callbackThreadTs: job.threadTs || null,
    })
    .returning({ id: jobExecutions.id });

  const executionId = execution.id;
  let provenance: Record<string, unknown> | null = null;

  try {
    const recipeCommand = job.recipeCommand?.trim();
    if (!recipeCommand) {
      throw new Error("recipe_command is required for recipe execution.");
    }

    const recipeRoot = resolveRecipeRoot(job.name, job.recipeRoot);
    const timeoutSeconds = clampRecipeTimeoutSeconds(job.recipeTimeoutSeconds);

    const sandbox = await getOrCreateSandbox();
    const envs = await getSandboxEnvs();

    // Guardrail: root must exist at publish/runtime.
    const rootCheck = await sandbox.commands.run(`test -d "${recipeRoot}" && echo ok || echo missing`, {
      timeoutMs: 5_000,
      envs,
    });
    if (rootCheck.stdout?.trim() !== "ok") {
      throw new Error(`Recipe root does not exist: ${recipeRoot}`);
    }

    const pidFile = `/tmp/recipe-job-${job.id}.pid`;
    const runnerScriptPath = `/tmp/run-recipe-${job.id}.sh`;
    const runnerScript = `#!/usr/bin/env bash
set -euo pipefail
PID_FILE="${pidFile}"
rm -f "$PID_FILE"
echo $$ > "$PID_FILE"
trap 'rm -f "$PID_FILE"' EXIT
${recipeCommand}
`;

    await sandbox.files.write(runnerScriptPath, runnerScript);
    const result = await sandbox.commands.run(
      `chmod 700 "${runnerScriptPath}" && bash "${runnerScriptPath}"`,
      {
        cwd: recipeRoot,
        timeoutMs: timeoutSeconds * 1000,
        envs,
      },
    );

    provenance = {
      mode: "recipe",
      recipeRoot,
      recipeCommand,
      recipeTimeoutSeconds: timeoutSeconds,
      cwd: recipeRoot,
      exitCode: result.exitCode,
      stdout: truncateOutput(result.stdout || "", 12_000),
      stderr: truncateOutput(result.stderr || "", 6_000),
    };

    if (result.exitCode !== 0) {
      throw new Error(`Recipe command exited with code ${result.exitCode}`);
    }

    // External state may have changed via stop_recipe_run; avoid overriding it.
    if (!(await isStillRunning(jobId))) {
      logger.info("runRecipe: status changed externally, skipping completion update", {
        jobId,
        executionId,
      });
      return false;
    }

    const summary = (result.stdout || "Recipe completed (no output)")
      .trim()
      .slice(0, 500);

    await db
      .update(jobExecutions)
      .set({
        status: "completed",
        finishedAt: new Date(),
        steps: provenance,
        summary,
        tokenUsage: null,
      })
      .where(eq(jobExecutions.id, executionId));

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const isNewDay = job.lastExecutionDate !== todayStr;

    if (isRecurring(job)) {
      await db
        .update(jobs)
        .set({
          status: "pending",
          executeAt: null,
          retries: 0,
          lastExecutedAt: now,
          executionCount: sql`${jobs.executionCount} + 1`,
          todayExecutions: isNewDay ? 1 : sql`${jobs.todayExecutions} + 1`,
          lastExecutionDate: todayStr,
          lastResult: summary.slice(0, 2000),
          updatedAt: now,
        })
        .where(eq(jobs.id, jobId));
    } else {
      await db
        .update(jobs)
        .set({
          status: "completed",
          result: summary.slice(0, 2000),
          lastExecutedAt: now,
          executionCount: sql`${jobs.executionCount} + 1`,
          updatedAt: now,
        })
        .where(eq(jobs.id, jobId));
    }

    if (job.channelId) {
      const firstLine = summary.split("\n")[0] || "completed";
      await safePostMessage(slackClient, {
        channel: job.channelId,
        thread_ts: job.threadTs || undefined,
        text: `Recipe "${job.name}" completed. ${firstLine}`,
      });
    }

    return true;
  } catch (error: any) {
    try {
      await db
        .update(jobExecutions)
        .set({
          status: "failed",
          finishedAt: new Date(),
          steps: provenance ?? undefined,
          error: error.message,
        })
        .where(eq(jobExecutions.id, executionId));
    } catch (traceErr: any) {
      logger.error("runRecipe: failed to update execution trace", {
        jobId,
        executionId,
        error: traceErr.message,
      });
    }

    // If status changed externally (e.g. stop_recipe_run), don't force retries.
    if (!(await isStillRunning(jobId))) {
      logger.info("runRecipe: status changed externally, skipping retry", {
        jobId,
        executionId,
      });
      return false;
    }

    const newRetries = job.retries + 1;

    if (newRetries < MAX_RETRIES) {
      const retryAt = new Date(Date.now() + RETRY_DELAY_MS);
      await db
        .update(jobs)
        .set({ status: "pending", executeAt: retryAt, retries: newRetries, updatedAt: new Date() })
        .where(eq(jobs.id, jobId));

      logger.warn("runRecipe: job retrying", {
        jobName: job.name,
        executionId,
        retries: newRetries,
        retryAt: retryAt.toISOString(),
      });
    } else {
      await db
        .update(jobs)
        .set({
          status: "failed",
          result: `Failed after ${MAX_RETRIES} retries: ${error.message}`,
          retries: newRetries,
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, jobId));

      try {
        if (job.requestedBy && job.requestedBy !== "aura") {
          const dmResult = await slackClient.conversations.open({
            users: job.requestedBy,
          });
          if (dmResult.channel?.id) {
            await safePostMessage(slackClient, {
              channel: dmResult.channel.id,
              text: `Recipe "${job.name}" failed after ${MAX_RETRIES} retries.\n\nError: ${error.message}`,
            });
          }
        }
      } catch {
        logger.error("runRecipe: failed to send escalation DM", { jobId, executionId });
      }
    }

    throw error;
  }
}

