import { Hono } from "hono";
import { db } from "../db/client.js";
import { jobs } from "@aura/db/schema";
import { eq } from "drizzle-orm";
import { executeJob } from "../cron/execute-job.js";
import { logger } from "../lib/logger.js";

export const executeNowApp = new Hono();

/**
 * POST /api/execute-now
 * Immediately execute a job.
 * Requires CRON_SECRET auth header.
 */
executeNowApp.post("/", async (c) => {
  const authHeader = c.req.header("Authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    logger.warn("execute-now: unauthorized request", {
      hasAuth: !!authHeader,
    });
    return c.json({ ok: false, error: "Unauthorized" }, 401);
  }

  try {
    const body = await c.req.json();
    const { jobId } = body;

    if (!jobId) {
      return c.json({ ok: false, error: "jobId is required" }, 400);
    }

    // Regular job execution
    const jobRows = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);

    const job = jobRows[0];
    if (!job) {
      return c.json({ ok: false, error: "Job not found" }, 404);
    }

    logger.info("execute-now: executing job", { jobId, jobName: job.name });
    await executeJob(job, "dispatch");

    return c.json({ ok: true });
  } catch (err) {
    logger.error("execute-now: failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      500,
    );
  }
});
