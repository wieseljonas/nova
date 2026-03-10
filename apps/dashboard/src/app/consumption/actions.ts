"use server";

import { db } from "@/lib/db";
import { messages, jobExecutions, jobs, userProfiles } from "@schema";
import { desc, sql, eq } from "drizzle-orm";

// Cost per 1M tokens (input / output) by model family.
// Historical messages without a model field use the default rate.
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "anthropic/claude-sonnet-4": { input: 3.0, output: 15.0 },
  "anthropic/claude-4-5-sonnet": { input: 3.0, output: 15.0 },
  "anthropic/claude-haiku-4-5": { input: 0.8, output: 4.0 },
  "anthropic/claude-3-5-sonnet": { input: 3.0, output: 15.0 },
  "anthropic/claude-3-5-haiku": { input: 0.8, output: 4.0 },
};
const DEFAULT_COST = { input: 3.0, output: 15.0 };

function getCostRate(model: string | null): { input: number; output: number } {
  if (!model) return DEFAULT_COST;
  return MODEL_COSTS[model] ?? DEFAULT_COST;
}

function computeCost(inputTokens: number, outputTokens: number, model: string | null): number {
  const rate = getCostRate(model);
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

const emptyResult = {
  dailyUsage: [] as { date: string; totalInput: number; totalOutput: number; totalTokens: number; messageCount: number; estimatedCost: number }[],
  perUser: [] as { userId: string; displayName: string | null; totalInput: number; totalOutput: number; totalTokens: number; messageCount: number; estimatedCost: number }[],
  perJob: [] as { jobId: string | null; jobName: string | null; totalTokens: number; executionCount: number; estimatedCost: number }[],
  totals: { totalTokens: 0, totalMessages: 0, avgDaily: 0, totalCost: 0 },
};

export async function getConsumptionData() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  try {
    // Daily usage with cost estimation
    const dailyUsage = await db
      .select({
        date: sql<string>`date_trunc('day', ${messages.createdAt})::date::text`.as("date"),
        totalInput: sql<number>`coalesce(sum(("token_usage"->>'inputTokens')::int), 0)`.as("total_input"),
        totalOutput: sql<number>`coalesce(sum(("token_usage"->>'outputTokens')::int), 0)`.as("total_output"),
        totalTokens: sql<number>`coalesce(sum(("token_usage"->>'totalTokens')::int), 0)`.as("total_tokens"),
        messageCount: sql<number>`count(*)`.as("message_count"),
      })
      .from(messages)
      .where(sql`"token_usage" IS NOT NULL AND ${messages.createdAt} >= ${thirtyDaysAgo}`)
      .groupBy(sql`date_trunc('day', ${messages.createdAt})::date`)
      .orderBy(sql`date_trunc('day', ${messages.createdAt})::date`);

    const dailyUsageWithCost = dailyUsage.map((d) => ({
      ...d,
      estimatedCost: computeCost(d.totalInput, d.totalOutput, null),
    }));

    // Per-user: attribute assistant message tokens to the thread-initiating human user.
    // Each assistant message with token_usage has a slack_thread_ts pointing to the
    // root of the conversation. We find the first user message in that thread to
    // identify the human who triggered the cost.
    const perUser = await db.execute(sql`
      WITH attributed AS (
        SELECT
          COALESCE(
            (SELECT m2.user_id FROM messages m2
             WHERE m2.slack_ts = m.slack_thread_ts AND m2.role = 'user'
             LIMIT 1),
            m.user_id
          ) AS attributed_user_id,
          ("token_usage"->>'inputTokens')::int AS input_tokens,
          ("token_usage"->>'outputTokens')::int AS output_tokens,
          ("token_usage"->>'totalTokens')::int AS total_tokens,
          m.model
        FROM messages m
        WHERE "token_usage" IS NOT NULL AND m.created_at >= ${thirtyDaysAgo}
      )
      SELECT
        a.attributed_user_id AS user_id,
        up.display_name,
        COALESCE(SUM(a.input_tokens), 0)::int AS total_input,
        COALESCE(SUM(a.output_tokens), 0)::int AS total_output,
        COALESCE(SUM(a.total_tokens), 0)::int AS total_tokens,
        COUNT(*)::int AS message_count
      FROM attributed a
      LEFT JOIN user_profiles up ON up.slack_user_id = a.attributed_user_id
      GROUP BY a.attributed_user_id, up.display_name
      ORDER BY total_tokens DESC
      LIMIT 20
    `);

    const perUserRows = ((perUser as any).rows ?? perUser) as Array<{
      user_id: string;
      display_name: string | null;
      total_input: number;
      total_output: number;
      total_tokens: number;
      message_count: number;
    }>;

    const perUserData = perUserRows.map((u) => ({
      userId: u.user_id,
      displayName: u.display_name,
      totalInput: Number(u.total_input),
      totalOutput: Number(u.total_output),
      totalTokens: Number(u.total_tokens),
      messageCount: Number(u.message_count),
      estimatedCost: computeCost(Number(u.total_input), Number(u.total_output), null),
    }));

    // Per-job: use the correct key names (inputTokens/outputTokens/totalTokens for
    // new executions, input/output/total for legacy ones)
    const perJob = await db
      .select({
        jobId: jobExecutions.jobId,
        jobName: jobs.name,
        totalTokens: sql<number>`coalesce(sum(
          COALESCE(("token_usage"->>'totalTokens')::int, ("token_usage"->>'total')::int, 0)
        ), 0)`.as("total_tokens"),
        totalInput: sql<number>`coalesce(sum(
          COALESCE(("token_usage"->>'inputTokens')::int, ("token_usage"->>'input')::int, 0)
        ), 0)`.as("total_input"),
        totalOutput: sql<number>`coalesce(sum(
          COALESCE(("token_usage"->>'outputTokens')::int, ("token_usage"->>'output')::int, 0)
        ), 0)`.as("total_output"),
        executionCount: sql<number>`count(*)`.as("execution_count"),
      })
      .from(jobExecutions)
      .leftJoin(jobs, eq(jobExecutions.jobId, jobs.id))
      .where(sql`"token_usage" IS NOT NULL AND ${jobExecutions.startedAt} >= ${thirtyDaysAgo}`)
      .groupBy(jobExecutions.jobId, jobs.name)
      .orderBy(desc(sql`total_tokens`))
      .limit(20);

    const perJobWithCost = perJob.map((j) => ({
      ...j,
      estimatedCost: computeCost(j.totalInput, j.totalOutput, null),
    }));

    const [totals] = await db
      .select({
        totalTokens: sql<number>`coalesce(sum(("token_usage"->>'totalTokens')::int), 0)`.as("total_tokens"),
        totalInput: sql<number>`coalesce(sum(("token_usage"->>'inputTokens')::int), 0)`.as("total_input"),
        totalOutput: sql<number>`coalesce(sum(("token_usage"->>'outputTokens')::int), 0)`.as("total_output"),
        totalMessages: sql<number>`count(*)`.as("total_messages"),
      })
      .from(messages)
      .where(sql`"token_usage" IS NOT NULL AND ${messages.createdAt} >= ${thirtyDaysAgo}`);

    const totalCost = computeCost(totals.totalInput || 0, totals.totalOutput || 0, null);

    return {
      dailyUsage: dailyUsageWithCost,
      perUser: perUserData,
      perJob: perJobWithCost,
      totals: {
        totalTokens: totals.totalTokens || 0,
        totalMessages: totals.totalMessages || 0,
        avgDaily: dailyUsage.length > 0 ? Math.round((totals.totalTokens || 0) / dailyUsage.length) : 0,
        totalCost,
      },
    };
  } catch {
    return emptyResult;
  }
}
