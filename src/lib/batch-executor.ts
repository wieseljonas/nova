import { eq, and } from "drizzle-orm";
import { WebClient } from "@slack/web-api";
import dns from "node:dns/promises";
import { db } from "../db/client.js";
import { batchProposals, batchItems } from "../db/schema.js";
import { getApiCredentialWithType } from "./api-credentials.js";
import { logger } from "./logger.js";

// ── Private IP Detection (SSRF prevention) ──────────────────────────────────

function isPrivateIP(ip: string): boolean {
  return (
    /^10\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^127\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    /^0\./.test(ip) ||
    ip === "::1"
  );
}

// ── Batch Executor ──────────────────────────────────────────────────────────

export interface BatchExecutionOptions {
  batchId: string;
  requestingUserId: string;
  slackClient?: WebClient;
  rateLimit?: {
    requestsPerSecond?: number;
    delayMs?: number;
  };
}

/**
 * Execute an approved batch proposal. Runs non-LLM loop over all items,
 * injects credentials, applies rate limiting, updates progress in DB + Slack.
 */
export async function executeBatch(
  options: BatchExecutionOptions,
): Promise<{ ok: true; successCount: number; failureCount: number } | { ok: false; error: string }> {
  const { batchId, requestingUserId, slackClient, rateLimit } = options;

  // Load batch proposal
  const [batch] = await db
    .select()
    .from(batchProposals)
    .where(eq(batchProposals.id, batchId))
    .limit(1);

  if (!batch) {
    return { ok: false, error: `Batch ${batchId} not found` };
  }

  if (batch.status !== "approved") {
    return { ok: false, error: `Batch ${batchId} has status ${batch.status}, expected approved` };
  }

  // Atomically claim the batch for execution
  const claimed = await db
    .update(batchProposals)
    .set({ status: "executing", executedAt: new Date() })
    .where(and(eq(batchProposals.id, batchId), eq(batchProposals.status, "approved")))
    .returning({ id: batchProposals.id });

  if (claimed.length === 0) {
    return { ok: false, error: `Batch ${batchId} already executing or completed` };
  }

  logger.info("Batch execution started", { batchId, total: batch.progressTotal });

  // Load all items
  const items = await db
    .select()
    .from(batchItems)
    .where(eq(batchItems.batchId, batchId))
    .orderBy(batchItems.index);

  let successCount = 0;
  let failureCount = 0;

  // Resolve credential once (if provided)
  let authHeaders: Record<string, string> = {};
  if (batch.credentialName && batch.credentialOwner) {
    const credResult = await getApiCredentialWithType(
      batch.credentialName,
      batch.credentialOwner,
      requestingUserId,
      "read",
    );

    if (!credResult) {
      await db
        .update(batchProposals)
        .set({ status: "failed", completedAt: new Date() })
        .where(eq(batchProposals.id, batchId));
      return { ok: false, error: `Credential "${batch.credentialName}" not found or expired` };
    }

    // Build auth headers based on scheme
    switch (credResult.authScheme) {
      case "bearer":
      case "oauth_client":
      case "google_service_account": {
        authHeaders["Authorization"] = `Bearer ${credResult.value}`;
        break;
      }
      case "basic": {
        let basicParsed: { username: string; password: string };
        try {
          basicParsed = JSON.parse(credResult.value);
        } catch {
          await db
            .update(batchProposals)
            .set({ status: "failed", completedAt: new Date() })
            .where(eq(batchProposals.id, batchId));
          return { ok: false, error: "basic credential value must be JSON {username, password}" };
        }
        const encoded = Buffer.from(`${basicParsed.username}:${basicParsed.password ?? ""}`).toString("base64");
        authHeaders["Authorization"] = `Basic ${encoded}`;
        break;
      }
      case "header": {
        let parsed: { key: string; secret: string };
        try {
          parsed = JSON.parse(credResult.value);
        } catch {
          await db
            .update(batchProposals)
            .set({ status: "failed", completedAt: new Date() })
            .where(eq(batchProposals.id, batchId));
          return { ok: false, error: "header credential value must be JSON {key, secret}" };
        }
        authHeaders[parsed.key] = parsed.secret;
        break;
      }
      default:
        await db
          .update(batchProposals)
          .set({ status: "failed", completedAt: new Date() })
          .where(eq(batchProposals.id, batchId));
        return { ok: false, error: `Unsupported auth scheme for batch execution: ${credResult.authScheme}` };
    }
  }

  const delayMs = rateLimit?.delayMs ?? 100;
  let lastUpdateTs = Date.now();
  const updateIntervalMs = 2000; // Update Slack card every 2s max

  // Execute items sequentially with rate limiting
  for (const item of items) {
    // Apply rate limiting
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    // Mark item as executing
    await db
      .update(batchItems)
      .set({ status: "executing" })
      .where(eq(batchItems.id, item.id));

    try {
      // SSRF check
      const { hostname } = new URL(item.url);
      const resolved = await dns.resolve4(hostname).catch(() => [] as string[]);
      for (const ip of resolved) {
        if (isPrivateIP(ip)) {
          throw new Error(`Blocked: ${hostname} resolves to private IP ${ip}`);
        }
      }

      // Build request headers
      const headers: Record<string, string> = {
        ...authHeaders,
        ...(item.headers as Record<string, string> | undefined),
      };

      // Set Content-Type if body present and not already set
      if (item.body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }

      // Execute HTTP request
      const response = await fetch(item.url, {
        method: item.method,
        headers,
        body: item.body ? JSON.stringify(item.body) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });

      let responseBody: unknown;
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        responseBody = await response.json().catch(() => null);
      }
      if (responseBody === undefined || responseBody === null) {
        const text = await response.text().catch(() => "");
        responseBody = text.length > 10_000 ? text.slice(0, 10_000) + "... (truncated)" : text;
      }

      const result = {
        ok: response.ok,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
      };

      await db
        .update(batchItems)
        .set({
          status: response.ok ? "success" : "failed",
          result,
          executedAt: new Date(),
          error: response.ok ? null : `HTTP ${response.status}`,
        })
        .where(eq(batchItems.id, item.id));

      if (response.ok) {
        successCount++;
      } else {
        failureCount++;
      }
    } catch (error: any) {
      logger.error("Batch item execution failed", { batchId, itemId: item.id, error: error.message });
      await db
        .update(batchItems)
        .set({
          status: "failed",
          executedAt: new Date(),
          error: error.message,
        })
        .where(eq(batchItems.id, item.id));
      failureCount++;
    }

    // Update batch progress
    const current = successCount + failureCount;
    await db
      .update(batchProposals)
      .set({ progressCurrent: current })
      .where(eq(batchProposals.id, batchId));

    // Update Slack card periodically
    const now = Date.now();
    if (slackClient && batch.approvalChannelId && batch.approvalMessageTs && now - lastUpdateTs >= updateIntervalMs) {
      await updateBatchProgressCard(
        slackClient,
        batchId,
        batch.approvalChannelId,
        batch.approvalMessageTs,
        current,
        batch.progressTotal,
        successCount,
        failureCount,
      );
      lastUpdateTs = now;
    }
  }

  // Mark batch as complete
  const finalStatus = failureCount === 0 ? "completed" : failureCount < batch.progressTotal ? "partially_completed" : "failed";
  await db
    .update(batchProposals)
    .set({
      status: finalStatus,
      completedAt: new Date(),
      progressCurrent: batch.progressTotal,
    })
    .where(eq(batchProposals.id, batchId));

  // Final Slack card update
  if (slackClient && batch.approvalChannelId && batch.approvalMessageTs) {
    await updateBatchCompletionCard(
      slackClient,
      batchId,
      batch.approvalChannelId,
      batch.approvalMessageTs,
      batch.progressTotal,
      successCount,
      failureCount,
      finalStatus,
    );
  }

  logger.info("Batch execution completed", { batchId, successCount, failureCount, finalStatus });

  return { ok: true, successCount, failureCount };
}

// ── Slack Card Updates ──────────────────────────────────────────────────────

async function updateBatchProgressCard(
  slackClient: WebClient,
  batchId: string,
  channelId: string,
  messageTs: string,
  current: number,
  total: number,
  successCount: number,
  failureCount: number,
): Promise<void> {
  const [batch] = await db
    .select()
    .from(batchProposals)
    .where(eq(batchProposals.id, batchId))
    .limit(1);

  if (!batch) return;

  const progressPercent = total > 0 ? Math.floor((current / total) * 100) : 0;
  const progressBar = buildProgressBar(current, total);

  const blocks: any[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*⏳ ${batch.summaryTitle ?? "Batch operation in progress"}*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${progressBar} ${progressPercent}%\n✅ ${successCount} succeeded · ❌ ${failureCount} failed · ${total - current} pending`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `\`executing\` · ${current}/${total} items processed`,
        },
      ],
    },
  ];

  try {
    await slackClient.chat.update({
      channel: channelId,
      ts: messageTs,
      text: `⏳ Batch operation: ${current}/${total} items processed`,
      attachments: [
        {
          color: "#e8912d",
          blocks,
        },
      ],
    });
  } catch (err) {
    logger.warn("updateBatchProgressCard: failed to update message", {
      error: err instanceof Error ? err.message : String(err),
      batchId,
    });
  }
}

async function updateBatchCompletionCard(
  slackClient: WebClient,
  batchId: string,
  channelId: string,
  messageTs: string,
  total: number,
  successCount: number,
  failureCount: number,
  status: string,
): Promise<void> {
  const [batch] = await db
    .select()
    .from(batchProposals)
    .where(eq(batchProposals.id, batchId))
    .limit(1);

  if (!batch) return;

  const isSuccess = status === "completed";
  const isPartial = status === "partially_completed";
  const prefix = isSuccess ? "✅" : isPartial ? "⚠️" : "❌";
  const color = isSuccess ? "#2eb67d" : isPartial ? "#e8912d" : "#e01e5a";
  const statusText = isSuccess ? "Completed successfully" : isPartial ? "Partially completed" : "Failed";
  const title = `${prefix} ${batch.summaryTitle ?? "Batch operation"}`;

  const blocks: any[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${title}*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `✅ ${successCount} succeeded · ❌ ${failureCount} failed · ${total} total`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View details", emoji: true },
          action_id: `batch_view_details_${batchId}`,
          value: batchId,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `\`${status}\` · ${statusText}`,
        },
      ],
    },
  ];

  try {
    await slackClient.chat.update({
      channel: channelId,
      ts: messageTs,
      text: `${prefix} Batch operation: ${statusText}`,
      attachments: [
        {
          color,
          blocks,
        },
      ],
    });
  } catch (err) {
    logger.warn("updateBatchCompletionCard: failed to update message", {
      error: err instanceof Error ? err.message : String(err),
      batchId,
    });
  }
}

function buildProgressBar(current: number, total: number, width: number = 20): string {
  if (total === 0) return "▱".repeat(width);
  const filled = Math.floor((current / total) * width);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}
