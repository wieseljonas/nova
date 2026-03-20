import { WebClient } from "@slack/web-api";
import { eq, and, inArray, sql, isNotNull } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  jobs,
  jobExecutions,
  credentials,
  recipeProxyGrants,
  credentialAuditLog,
} from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { safePostMessage } from "../lib/slack-messaging.js";
import { executionContext } from "../lib/tool.js";
import { mintProxyToken } from "../lib/proxy-token.js";
import {
  getOrCreateSandbox,
  getSandboxEnvs,
  truncateOutput,
  markRecipeRunning,
  clearRecipeRunning,
} from "../lib/sandbox.js";
import {
  clampRecipeTimeoutSeconds,
  resolveRecipeRoot,
} from "../lib/recipes.js";
import { MAX_RETRIES } from "./execute-job.js";

const botToken = process.env.SLACK_BOT_TOKEN || "";
const slackClient = new WebClient(botToken);
const RETRY_DELAY_MS = 10 * 60 * 1000;
const RECIPE_KEEPALIVE_MS = 15 * 60 * 1000;
const RUNNING_SENTINEL = "__RUNNING__";
const RECIPE_STDOUT_LIMIT = 12_000;
const RECIPE_STDERR_LIMIT = 6_000;
const RECIPE_SUMMARY_LIMIT = 500;

export interface RunningRecipeResult {
  kind: "recipe_runtime";
  pid: string;
  pidFile: string;
  stdoutFile: string;
  stderrFile: string;
  exitFile: string;
  sandboxId: string;
  executionId: string;
  recipeRoot: string;
  recipeCommand: string;
  recipeTimeoutSeconds: number;
  launchedAt: string;
  stopRequestedBy?: string;
  stopRequestedAt?: string;
}

function getProxyBaseUrl(): string {
  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const base = productionHost
    ? productionHost.startsWith("http")
      ? productionHost
      : `https://${productionHost}`
    : "https://aura-alpha-five.vercel.app";
  return base.replace(/\/+$/, "");
}

async function buildRecipeProxyEnvs(
  job: typeof jobs.$inferSelect,
  executionId: string,
  timeoutSeconds: number,
): Promise<Record<string, string>> {
  const proxyMode = job.recipeProxyMode || "off";
  if (proxyMode === "off") return {};
  if (proxyMode === "one_shot" && isRecurring(job)) {
    throw new Error(
      "Recipe proxy mode 'one_shot' cannot run on recurring jobs. Republish with proxy_mode='recurring_auto'.",
    );
  }

  const grantRows = await db
    .select({
      id: recipeProxyGrants.id,
      credentialOwnerUserId: recipeProxyGrants.credentialOwnerUserId,
      credentialIds: recipeProxyGrants.credentialIds,
      credentialKeys: recipeProxyGrants.credentialKeys,
      status: recipeProxyGrants.status,
      useCount: recipeProxyGrants.useCount,
    })
    .from(recipeProxyGrants)
    .where(eq(recipeProxyGrants.jobId, job.id))
    .limit(1);
  const grant = grantRows[0];
  if (!grant || grant.status !== "active") {
    throw new Error(
      "Recipe proxy is configured but no active proxy grant exists. Republish the recipe to approve proxy access.",
    );
  }

  const credentialIds = grant.credentialIds ?? [];
  const credentialKeys = grant.credentialKeys ?? [];
  if (credentialIds.length === 0 || credentialKeys.length === 0) {
    throw new Error(
      "Recipe proxy grant is empty. Republish the recipe with proxy credentials.",
    );
  }

  const rows = await db
    .select({
      id: credentials.id,
      key: credentials.key,
    })
    .from(credentials)
    .where(inArray(credentials.id, credentialIds));
  const foundKeys = new Set(rows.map((r) => r.key));
  const missingKeys = credentialKeys.filter((k) => !foundKeys.has(k));
  if (missingKeys.length > 0) {
    throw new Error(
      `Recipe proxy grant references missing credential(s): ${missingKeys.join(", ")}.`,
    );
  }

  const ttlMinutes = Math.min(
    60,
    Math.max(5, Math.ceil(timeoutSeconds / 60) + 5),
  );
  const proxyToken = mintProxyToken({
    credentialKeys,
    userId: job.requestedBy || "aura",
    credentialOwner: grant.credentialOwnerUserId,
    ttlMinutes,
  });

  const now = new Date();
  await db
    .update(recipeProxyGrants)
    .set({
      lastUsedAt: now,
      useCount: sql`${recipeProxyGrants.useCount} + 1`,
      updatedAt: now,
    })
    .where(eq(recipeProxyGrants.id, grant.id));

  try {
    const idByKey = new Map(rows.map((r) => [r.key, r.id]));
    await db
      .insert(credentialAuditLog)
      .values(
        credentialKeys.map((key) => ({
          credentialId: idByKey.get(key) ?? null,
          credentialName: key,
          accessedBy: job.requestedBy || "aura",
          action: "use" as const,
          context: JSON.stringify({
            source: "recipe_proxy_grant",
            jobId: job.id,
            executionId,
            proxyMode,
          }),
        })),
      );
  } catch (auditErr: any) {
    logger.warn("runRecipe: proxy grant audit failed", {
      jobId: job.id,
      executionId,
      error: auditErr.message,
    });
  }

  return {
    NOVA_PROXY_URL: `${getProxyBaseUrl()}/proxy`,
    NOVA_PROXY_TOKEN: proxyToken,
  };
}

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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseExitCode(stdout: string): number | null {
  const firstLine = stdout.trim().split("\n")[0]?.trim();
  if (!firstLine) return null;
  const exitCode = Number(firstLine);
  return Number.isInteger(exitCode) ? exitCode : null;
}

function buildRecipeSummary(stdout: string): string {
  return (stdout || "Recipe completed (no output)")
    .trim()
    .slice(0, RECIPE_SUMMARY_LIMIT);
}

function buildRecipeTempPaths(jobId: string): {
  pidFile: string;
  stdoutFile: string;
  stderrFile: string;
  exitFile: string;
} {
  return {
    pidFile: `/tmp/recipe_${jobId}.pid`,
    stdoutFile: `/tmp/recipe_${jobId}.stdout`,
    stderrFile: `/tmp/recipe_${jobId}.stderr`,
    exitFile: `/tmp/recipe_${jobId}.exit`,
  };
}

export function parseRunningRecipeResult(
  rawResult: string | null | undefined,
): RunningRecipeResult | null {
  if (!rawResult) return null;

  try {
    const parsed = JSON.parse(rawResult) as Partial<RunningRecipeResult>;
    if (!parsed || parsed.kind !== "recipe_runtime") return null;

    const requiredStringKeys: Array<keyof RunningRecipeResult> = [
      "pid",
      "pidFile",
      "stdoutFile",
      "stderrFile",
      "exitFile",
      "sandboxId",
      "executionId",
      "recipeRoot",
      "recipeCommand",
      "launchedAt",
    ];
    for (const key of requiredStringKeys) {
      if (typeof parsed[key] !== "string" || parsed[key].length === 0) {
        return null;
      }
    }
    if (typeof parsed.recipeTimeoutSeconds !== "number") return null;

    return parsed as RunningRecipeResult;
  } catch {
    return null;
  }
}

async function resolveRunningExecutionId(
  jobId: string,
  preferredExecutionId?: string,
): Promise<string | null> {
  if (preferredExecutionId) {
    const preferred = await db
      .select({ id: jobExecutions.id })
      .from(jobExecutions)
      .where(
        and(
          eq(jobExecutions.id, preferredExecutionId),
          eq(jobExecutions.jobId, jobId),
          eq(jobExecutions.status, "running"),
        ),
      )
      .limit(1);
    if (preferred[0]?.id) return preferred[0].id;
  }

  const rows = await db
    .select({ id: jobExecutions.id })
    .from(jobExecutions)
    .where(
      and(
        eq(jobExecutions.jobId, jobId),
        eq(jobExecutions.status, "running"),
      ),
    )
    .orderBy(sql`${jobExecutions.startedAt} DESC`)
    .limit(1);

  return rows[0]?.id ?? preferredExecutionId ?? null;
}

async function readOutputTail(
  sandbox: any,
  filePath: string,
  limitChars: number,
): Promise<string> {
  const readCmd = `if [ -f ${shellQuote(filePath)} ]; then tail -c ${limitChars} ${shellQuote(filePath)}; fi`;
  const result = await sandbox.commands.run(`bash -lc ${shellQuote(readCmd)}`, {
    timeoutMs: 10_000,
  });
  return result.stdout || "";
}

async function connectSandboxById(sandboxId: string): Promise<any> {
  const { Sandbox } = await import("e2b");
  return Sandbox.connect(sandboxId, { timeoutMs: RECIPE_KEEPALIVE_MS });
}

async function cleanupRecipeTempFiles(
  sandbox: any,
  state: RunningRecipeResult,
): Promise<void> {
  const cleanupCmd = `rm -f ${shellQuote(state.pidFile)} ${shellQuote(state.stdoutFile)} ${shellQuote(state.stderrFile)} ${shellQuote(state.exitFile)}`;
  await sandbox.commands.run(cleanupCmd, { timeoutMs: 10_000 });
}

async function markRecipeSucceeded(
  job: typeof jobs.$inferSelect,
  executionId: string | null,
  summary: string,
  provenance: Record<string, unknown>,
): Promise<void> {
  if (executionId) {
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
  }

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
        result: null,
        updatedAt: now,
      })
      .where(eq(jobs.id, job.id));
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
      .where(eq(jobs.id, job.id));
  }

  if (job.channelId) {
    const firstLine = summary.split("\n")[0] || "completed";
    await safePostMessage(slackClient, {
      channel: job.channelId,
      thread_ts: job.threadTs || undefined,
      text: `Recipe "${job.name}" completed. ${firstLine}`,
    });
  }
}

async function markRecipeFailed(
  job: typeof jobs.$inferSelect,
  executionId: string | null,
  errorMessage: string,
  provenance: Record<string, unknown> | null,
  options?: {
    skipRetry?: boolean;
    markAsFailed?: boolean;
  },
): Promise<void> {
  if (executionId) {
    try {
      await db
        .update(jobExecutions)
        .set({
          status: "failed",
          finishedAt: new Date(),
          steps: provenance ?? undefined,
          error: errorMessage,
        })
        .where(eq(jobExecutions.id, executionId));
    } catch (traceErr: any) {
      logger.error("runRecipe: failed to update execution trace", {
        jobId: job.id,
        executionId,
        error: traceErr.message,
      });
    }
  }

  if (options?.markAsFailed) {
    await db
      .update(jobs)
      .set({
        status: "failed",
        result: errorMessage.slice(0, 2000),
        retries: sql`${jobs.retries} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, job.id));
    return;
  }

  if (options?.skipRetry) {
    const now = new Date();
    if (isRecurring(job)) {
      await db
        .update(jobs)
        .set({
          status: "pending",
          executeAt: null,
          retries: 0,
          lastExecutedAt: now,
          lastResult: errorMessage.slice(0, 2000),
          result: null,
          updatedAt: now,
        })
        .where(eq(jobs.id, job.id));
    } else {
      await db
        .update(jobs)
        .set({
          status: "cancelled",
          result: errorMessage.slice(0, 2000),
          updatedAt: now,
        })
        .where(eq(jobs.id, job.id));
    }
    return;
  }

  // If status changed externally (e.g. stop_recipe_run), don't force retries.
  if (!(await isStillRunning(job.id))) {
    logger.info("runRecipe: status changed externally, skipping retry", {
      jobId: job.id,
      executionId,
    });
    return;
  }

  const newRetries = job.retries + 1;
  if (newRetries < MAX_RETRIES) {
    const retryAt = new Date(Date.now() + RETRY_DELAY_MS);
    await db
      .update(jobs)
      .set({
        status: "pending",
        executeAt: retryAt,
        retries: newRetries,
        result: null,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, job.id));

    logger.warn("runRecipe: job retrying", {
      jobName: job.name,
      executionId,
      retries: newRetries,
      retryAt: retryAt.toISOString(),
    });
    return;
  }

  await db
    .update(jobs)
    .set({
      status: "failed",
      result: `Failed after ${MAX_RETRIES} retries: ${errorMessage}`,
      retries: newRetries,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, job.id));

  try {
    if (job.requestedBy && job.requestedBy !== "aura") {
      const dmResult = await slackClient.conversations.open({
        users: job.requestedBy,
      });
      if (dmResult.channel?.id) {
        await safePostMessage(slackClient, {
          channel: dmResult.channel.id,
          text: `Recipe "${job.name}" failed after ${MAX_RETRIES} retries.\n\nError: ${errorMessage}`,
        });
      }
    }
  } catch {
    logger.error("runRecipe: failed to send escalation DM", {
      jobId: job.id,
      executionId,
    });
  }
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
  let launchState: RunningRecipeResult | null = null;

  try {
    const recipeCommand = job.recipeCommand?.trim();
    if (!recipeCommand) {
      throw new Error("recipe_command is required for recipe execution.");
    }

    const recipeRoot = resolveRecipeRoot(job.name, job.recipeRoot);
    const timeoutSeconds = clampRecipeTimeoutSeconds(job.recipeTimeoutSeconds);
    const tempPaths = buildRecipeTempPaths(job.id);

    launchState = await executionContext.run(
      {
        triggeredBy: job.requestedBy || "aura",
        triggerType: "scheduled_job",
        jobId: job.id,
        channelId: job.channelId || undefined,
        threadTs: job.threadTs || undefined,
      },
      async () => {
        const sandbox = await getOrCreateSandbox();
        const envs = await getSandboxEnvs();
        const proxyEnvs = await buildRecipeProxyEnvs(
          job,
          executionId,
          timeoutSeconds,
        );
        const runEnvs = { ...envs, ...proxyEnvs };

        // Guardrail: root must exist at publish/runtime.
        const rootCheck = await sandbox.commands.run(
          `test -d "${recipeRoot}" && echo ok || echo missing`,
          {
            timeoutMs: 5_000,
            envs: runEnvs,
          },
        );
        if (rootCheck.stdout?.trim() !== "ok") {
          throw new Error(`Recipe root does not exist: ${recipeRoot}`);
        }

        const launchPayload = `${recipeCommand} > ${tempPaths.stdoutFile} 2> ${tempPaths.stderrFile}; echo $? > ${tempPaths.exitFile}`;
        const launchCmd = [
          `rm -f ${shellQuote(tempPaths.pidFile)} ${shellQuote(tempPaths.stdoutFile)} ${shellQuote(tempPaths.stderrFile)} ${shellQuote(tempPaths.exitFile)}`,
          `nohup bash -lc ${shellQuote(launchPayload)} </dev/null >/dev/null 2>&1 & echo $! > ${shellQuote(tempPaths.pidFile)}`,
        ].join(" && ");

        await sandbox.commands.run(launchCmd, {
          timeoutMs: 10_000,
          cwd: recipeRoot,
          envs: runEnvs,
        });

        const pidResult = await sandbox.commands.run(
          `cat ${shellQuote(tempPaths.pidFile)}`,
          {
            timeoutMs: 5_000,
            cwd: recipeRoot,
            envs: runEnvs,
          },
        );
        const pid = (pidResult.stdout || "").trim();
        if (!pid || !/^[0-9]+$/.test(pid)) {
          throw new Error(
            `Failed to launch recipe process: pid file missing or invalid (${tempPaths.pidFile})`,
          );
        }

        return {
          kind: "recipe_runtime" as const,
          pid,
          pidFile: tempPaths.pidFile,
          stdoutFile: tempPaths.stdoutFile,
          stderrFile: tempPaths.stderrFile,
          exitFile: tempPaths.exitFile,
          sandboxId: String(sandbox.sandboxId),
          executionId,
          recipeRoot,
          recipeCommand,
          recipeTimeoutSeconds: timeoutSeconds,
          launchedAt: new Date().toISOString(),
        };
      },
    );

    markRecipeRunning(jobId);

    await db
      .update(jobs)
      .set({
        status: "running",
        result: JSON.stringify(launchState),
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, jobId));

    await db
      .update(jobExecutions)
      .set({
        summary: `Recipe dispatched (pid ${launchState.pid})`,
        steps: {
          mode: "recipe",
          phase: "launched",
          ...launchState,
        },
      })
      .where(eq(jobExecutions.id, executionId));

    logger.info("runRecipe: recipe dispatched", {
      jobId,
      executionId,
      pid: launchState.pid,
      sandboxId: launchState.sandboxId,
    });

    return true;
  } catch (error: any) {
    clearRecipeRunning(jobId);
    const provenance = launchState
      ? {
          mode: "recipe",
          phase: "launch_failed",
          ...launchState,
        }
      : null;
    await markRecipeFailed(job, executionId, error.message, provenance);
    throw error;
  }
}

export async function pollRunningRecipes(): Promise<{
  checked: number;
  running: number;
  completed: number;
  failed: number;
}> {
  const runningJobs = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.status, "running"),
        isNotNull(jobs.recipeCommand),
      ),
    );

  if (runningJobs.length === 0) {
    return { checked: 0, running: 0, completed: 0, failed: 0 };
  }

  const defaultSandbox = await getOrCreateSandbox();
  const sandboxById = new Map<string, any>([
    [String(defaultSandbox.sandboxId), defaultSandbox],
  ]);
  const stats = { checked: 0, running: 0, completed: 0, failed: 0 };

  for (const job of runningJobs) {
    stats.checked++;
    const state = parseRunningRecipeResult(job.result);

    if (!state) {
      clearRecipeRunning(job.id);
      const executionId = await resolveRunningExecutionId(job.id);
      await markRecipeFailed(
        job,
        executionId,
        "Recipe runtime metadata missing from jobs.result; unable to poll process.",
        { mode: "recipe", phase: "poll_metadata_missing" },
        { markAsFailed: true },
      );
      stats.failed++;
      continue;
    }

    const executionId = await resolveRunningExecutionId(job.id, state.executionId);
    let sandbox = sandboxById.get(state.sandboxId);

    try {
      if (!sandbox) {
        logger.info("pollRunningRecipes: connecting to sandbox for running recipe", {
          jobId: job.id,
          sandboxId: state.sandboxId,
        });
        sandbox = await connectSandboxById(state.sandboxId);
        sandboxById.set(state.sandboxId, sandbox);
      }

      const exitCheckCmd = `if [ -f ${shellQuote(state.exitFile)} ]; then cat ${shellQuote(state.exitFile)}; else echo ${RUNNING_SENTINEL}; fi`;
      const exitCheck = await sandbox.commands.run(
        `bash -lc ${shellQuote(exitCheckCmd)}`,
        { timeoutMs: 5_000 },
      );
      const exitRaw = (exitCheck.stdout || "").trim();

      if (exitRaw === RUNNING_SENTINEL) {
        markRecipeRunning(job.id);
        try {
          await sandbox.setTimeout(RECIPE_KEEPALIVE_MS);
        } catch (timeoutErr: any) {
          logger.warn("pollRunningRecipes: failed to extend sandbox timeout", {
            jobId: job.id,
            sandboxId: state.sandboxId,
            error: timeoutErr.message,
          });
        }
        stats.running++;
        continue;
      }

      clearRecipeRunning(job.id);

      const stdout = await readOutputTail(
        sandbox,
        state.stdoutFile,
        RECIPE_STDOUT_LIMIT,
      );
      const stderr = await readOutputTail(
        sandbox,
        state.stderrFile,
        RECIPE_STDERR_LIMIT,
      );
      const exitCode = parseExitCode(exitRaw);
      const summary = buildRecipeSummary(stdout);
      const provenance: Record<string, unknown> = {
        mode: "recipe",
        phase: "completed",
        pid: state.pid,
        sandboxId: state.sandboxId,
        recipeRoot: state.recipeRoot,
        recipeCommand: state.recipeCommand,
        recipeTimeoutSeconds: state.recipeTimeoutSeconds,
        launchedAt: state.launchedAt,
        stopRequestedBy: state.stopRequestedBy || null,
        stopRequestedAt: state.stopRequestedAt || null,
        exitCode,
        stdout: truncateOutput(stdout || "", RECIPE_STDOUT_LIMIT),
        stderr: truncateOutput(stderr || "", RECIPE_STDERR_LIMIT),
      };

      if (exitCode === 0) {
        await markRecipeSucceeded(job, executionId, summary, provenance);
        stats.completed++;
      } else {
        const stoppedByUser = Boolean(state.stopRequestedBy);
        const errorMessage = stoppedByUser
          ? `Recipe run stopped by ${state.stopRequestedBy}`
          : `Recipe command exited with code ${exitCode ?? "unknown"}`;
        await markRecipeFailed(
          job,
          executionId,
          errorMessage,
          provenance,
          stoppedByUser ? { skipRetry: true } : undefined,
        );
        stats.failed++;
      }

      try {
        await cleanupRecipeTempFiles(sandbox, state);
      } catch (cleanupErr: any) {
        logger.warn("pollRunningRecipes: failed to clean temp files", {
          jobId: job.id,
          error: cleanupErr.message,
        });
      }
    } catch (error: any) {
      logger.error("pollRunningRecipes: failed while polling recipe", {
        jobId: job.id,
        executionId,
        error: error.message,
      });
    }
  }

  return stats;
}

