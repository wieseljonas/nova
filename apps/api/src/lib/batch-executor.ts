import { WebClient } from "@slack/web-api";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { approvals, approvalItems, type Approval } from "@aura/db/schema";
import { injectCredentialAuth, type ResolvedCredentialAuth } from "./credential-auth.js";
import { isPrivateUrl } from "./ssrf.js";
import { logger } from "./logger.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProposalItem {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface CreateProposalArgs {
  title: string;
  description?: string;
  credentialKey?: string;
  credentialOwner?: string;
  items: ProposalItem[];
  requestedBy: string;
  requestedInChannel?: string;
  requestedInThread?: string;
  slackClient?: WebClient;
}

// ── Risk Tier Colors ─────────────────────────────────────────────────────────

const RISK_COLORS: Record<string, string> = {
  write: "#e8912d",       // orange
  destructive: "#e01e5a", // red
  read: "#2eb67d",        // green
};

const COLOR_EXECUTING = "#0d7fce";  // blue
const COLOR_COMPLETED = "#2eb67d";  // green
const COLOR_FAILED = "#e01e5a";     // red

// ── Create Proposal ──────────────────────────────────────────────────────────

/**
 * Create a batch approval proposal and post a Slack approval card.
 * Returns the approval ID for tracking.
 */
export async function createProposal(args: CreateProposalArgs): Promise<{
  ok: boolean;
  approvalId?: string;
  error?: string;
}> {
  const { title, description, credentialKey, credentialOwner, items, requestedBy, requestedInChannel, requestedInThread, slackClient: injectedSlackClient } = args;

  if (items.length === 0) {
    return { ok: false, error: "No items to approve" };
  }

  const slackClient = injectedSlackClient ?? new WebClient(process.env.SLACK_BOT_TOKEN);

  try {
    // Determine URL pattern and method from first item
    const firstItem = items[0];
    const method = firstItem.method.toUpperCase();
    const url = firstItem.url;

    // Look up credential to get approvers for the Slack card
    let approverIds: string[] = [];
    let approvalChannel: string | null = null;
    if (credentialKey && credentialOwner) {
      const { credentials } = await import("@aura/db/schema");
      const { getApprovers, getApprovalChannel } = await import("./approval.js");
      const credRows = await db
        .select()
        .from(credentials)
        .where(
          and(
            eq(credentials.key, credentialKey),
            eq(credentials.ownerUserId, credentialOwner)
          )
        )
        .limit(1);
      
      const credential = credRows[0];
      if (credential) {
        approverIds = getApprovers(credential);
        approvalChannel = getApprovalChannel(credential);
      }
    }

    // Create approval record
    const [approval] = await db
      .insert(approvals)
      .values({
        title,
        description: description ?? null,
        credentialKey: credentialKey ?? null,
        credentialOwner: credentialOwner ?? requestedBy,
        urlPattern: url.split("?")[0],
        httpMethod: method,
        totalItems: items.length,
        requestedBy,
        requestedInChannel: requestedInChannel ?? null,
        requestedInThread: requestedInThread ?? null,
      })
      .returning({ id: approvals.id });

    const approvalId = approval.id;

    // Create approval items
    await db.insert(approvalItems).values(
      items.map((item, index) => ({
        approvalId,
        sequenceNum: index + 1,
        method: item.method.toUpperCase(),
        url: item.url,
        body: item.body as any ?? null,
        headers: item.headers as any ?? null,
      })),
    );

    // Build Slack approval card
    const approverMentions =
      approverIds.length > 0
        ? approverIds.map((id) => `<@${id}>`).join(", ")
        : "admins";

    const riskColor = RISK_COLORS.write; // All write operations use orange
    const itemSummary = items.length === 1
      ? `${method} ${url}`
      : `${items.length} operations (${method} to ${url.split("/")[2] ?? "API"})`;

    const attachmentBlocks: any[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*🔒 ${title}*`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: description ?? itemSummary,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "✅ Approve", emoji: true },
            style: "primary",
            action_id: `approval_approve_${approvalId}`,
            value: approvalId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "❌ Reject", emoji: true },
            style: "danger",
            action_id: `approval_reject_${approvalId}`,
            value: approvalId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "📋 Review items", emoji: true },
            action_id: `approval_review_${approvalId}`,
            value: approvalId,
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `\`write\` · ${items.length} item${items.length > 1 ? "s" : ""} · requested by <@${requestedBy}> · ${approverMentions}`,
          },
        ],
      },
    ];

    // Post to Slack
    const targetChannel = approvalChannel ?? requestedInChannel ?? process.env.AURA_DEFAULT_CHANNEL;

    if (!targetChannel) {
      logger.warn("createProposal: no channel to post approval to", { approvalId });
      return { ok: false, error: "No approval channel configured" };
    }

    const resp = await slackClient.chat.postMessage({
      ...(requestedInThread && { thread_ts: requestedInThread }),
      channel: targetChannel,
      text: `🔒 Approval required: ${title} — ${approverMentions}`,
      attachments: [
        {
          color: riskColor,
          blocks: attachmentBlocks,
        },
      ],
      metadata: {
        event_type: "batch_approval_request",
        event_payload: {
          approval_id: approvalId,
        },
      },
    });

    const ts = resp.ts ?? "";
    const postedChannel = resp.channel ?? targetChannel;

    // Update approval with Slack message info
    await db
      .update(approvals)
      .set({
        slackMessageTs: ts,
        slackChannel: postedChannel,
      })
      .where(eq(approvals.id, approvalId));

    logger.info("Batch approval proposal created", {
      approvalId,
      itemCount: items.length,
      channel: postedChannel,
      ts,
    });

    return { ok: true, approvalId };
  } catch (err) {
    logger.error("createProposal failed", {
      error: err instanceof Error ? err.message : String(err),
      title,
      itemCount: items.length,
    });
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ── Execute Batch Proposal ───────────────────────────────────────────────────

/**
 * Execute all items in an approved batch proposal.
 * Uses circuit breaker: stops if >20% of last 50 items failed.
 * Updates Slack card progress every 10 items.
 */
export async function executeBatchProposal(args: {
  approvalId: string;
  slackClient?: WebClient;
}): Promise<{ ok: boolean; error?: string }> {
  const { approvalId, slackClient: injectedSlackClient } = args;
  const slackClient = injectedSlackClient ?? new WebClient(process.env.SLACK_BOT_TOKEN);

  try {
    // Load approval
    const approvalRows = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .limit(1);

    const approval = approvalRows[0];
    if (!approval) {
      return { ok: false, error: "Approval not found" };
    }

    if (approval.status !== "approved") {
      return { ok: false, error: `Approval status is ${approval.status}, expected approved` };
    }

    // Update status to executing
    await db
      .update(approvals)
      .set({ status: "executing", updatedAt: new Date() })
      .where(eq(approvals.id, approvalId));

    // Update Slack card to show executing
    await updateApprovalCard(slackClient, approval, "executing");

    // Load all items
    const itemRows = await db
      .select()
      .from(approvalItems)
      .where(eq(approvalItems.approvalId, approvalId))
      .orderBy(approvalItems.sequenceNum);

    if (itemRows.length === 0) {
      await db
        .update(approvals)
        .set({ status: "completed", updatedAt: new Date() })
        .where(eq(approvals.id, approvalId));
      return { ok: true };
    }

    if (itemRows.length !== approval.totalItems) {
      logger.error("executeBatchProposal: item count mismatch — possible tampering", {
        approvalId,
        expected: approval.totalItems,
        actual: itemRows.length,
      });
      await db
        .update(approvals)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(approvals.id, approvalId));
      await updateApprovalCard(slackClient, approval, "failed", "Item count mismatch — execution aborted");
      return { ok: false, error: `Item count mismatch: expected ${approval.totalItems}, found ${itemRows.length}` };
    }

    // Get credential for requests
    const { getApiCredentialWithType } = await import("./api-credentials.js");
    let credential: ResolvedCredentialAuth | null = null;
    if (approval.credentialKey && approval.credentialOwner) {
      try {
        // Get credential value with type info
        const resolved = await getApiCredentialWithType(
          approval.credentialKey,
          approval.credentialOwner,
          approval.credentialOwner,
          "write",
        );
        if (!resolved) {
          throw new Error(
            `Credential with key '${approval.credentialKey}' owned by '${approval.credentialOwner}' not found or expired`,
          );
        }
        credential = {
          authScheme: resolved.authScheme,
          value: resolved.value,
        };
      } catch (err) {
        logger.error("executeBatchProposal: failed to load credential", {
          approvalId,
          credentialKey: approval.credentialKey,
          error: err,
        });
        await db
          .update(approvals)
          .set({ status: "failed", updatedAt: new Date() })
          .where(eq(approvals.id, approvalId));
        const errMsg = `Failed to load credential '${approval.credentialKey}'. ${err instanceof Error ? err.message : ""}`.trim();
        await updateApprovalCard(slackClient, approval, "failed", errMsg);
        return { ok: false, error: errMsg };
      }
    }

    // Execute items with circuit breaker
    const recentFailures: boolean[] = [];
    const CIRCUIT_WINDOW = 50;
    const CIRCUIT_THRESHOLD = 0.2; // 20%

    let completed = 0;
    let failed = 0;
    const itemResults: Array<{
      sequenceNum: number;
      method: string;
      ok: boolean;
      status?: number;
      error?: string;
    }> = [];

    for (const item of itemRows) {
      // Check circuit breaker
      if (recentFailures.length >= CIRCUIT_WINDOW) {
        const failureRate = recentFailures.filter(Boolean).length / CIRCUIT_WINDOW;
        if (failureRate > CIRCUIT_THRESHOLD) {
          logger.error("executeBatchProposal: circuit breaker tripped", {
            approvalId,
            failureRate,
            completed,
            failed,
          });
          // Mark remaining items as skipped
          await db
            .update(approvalItems)
            .set({ status: "skipped" })
            .where(and(eq(approvalItems.approvalId, approvalId), eq(approvalItems.status, "pending")));
          break;
        }
      }

      // Update item status to executing
      await db
        .update(approvalItems)
        .set({ status: "executing" })
        .where(eq(approvalItems.id, item.id));

      // Execute HTTP request
      const executionResult = await executeHttpRequest({
        method: item.method,
        url: item.url,
        body: item.body as any,
        headers: item.headers as any,
        credential,
      });

      // Update item with result
      await db
        .update(approvalItems)
        .set({
          status: executionResult.ok ? "succeeded" : "failed",
          responseStatus: executionResult.status ?? null,
          responseBody: executionResult.body as any ?? null,
          error: executionResult.error ?? null,
          executedAt: new Date(),
        })
        .where(eq(approvalItems.id, item.id));

      itemResults.push({
        sequenceNum: item.sequenceNum,
        method: item.method,
        ok: executionResult.ok,
        status: executionResult.status,
        error: executionResult.error,
      });

      if (executionResult.ok) {
        completed++;
        recentFailures.push(false);
      } else {
        failed++;
        recentFailures.push(true);
      }

      // Trim circuit breaker window
      if (recentFailures.length > CIRCUIT_WINDOW) {
        recentFailures.shift();
      }

      // Update approval progress
      await db
        .update(approvals)
        .set({
          completedItems: completed,
          failedItems: failed,
          updatedAt: new Date(),
        })
        .where(eq(approvals.id, approvalId));

      // Update Slack card every 10 items
      if ((completed + failed) % 10 === 0 || completed + failed === itemRows.length) {
        await updateApprovalCard(slackClient, approval, "executing", undefined, completed, failed, itemRows.length);
      }
    }

    // Final status
    const finalStatus = failed > 0 ? "completed" : "completed"; // Always completed even with failures
    await db
      .update(approvals)
      .set({
        status: finalStatus,
        completedItems: completed,
        failedItems: failed,
        updatedAt: new Date(),
      })
      .where(eq(approvals.id, approvalId));

    await updateApprovalCard(slackClient, approval, "completed", undefined, completed, failed, itemRows.length);

    logger.info("Batch execution completed", {
      approvalId,
      total: itemRows.length,
      completed,
      failed,
    });

    // ── Post results back to the original conversation thread ──────────────
    if (slackClient && approval.requestedInChannel && approval.requestedInThread) {
      try {
        const MAX_MESSAGE_LENGTH = 3500;
        const summaryHeader = failed > 0
          ? `:warning: *${approval.title ?? "Batch"}* — Completed with ${failed} failure${failed > 1 ? "s" : ""} (${completed}/${itemResults.length} succeeded)`
          : `:white_check_mark: *${approval.title ?? "Batch"}* — ${completed}/${itemResults.length} completed successfully`;

        const resultLines: string[] = [];
        let totalLength = summaryHeader.length;

        for (const r of itemResults) {
          const line = r.ok
            ? `• Item ${r.sequenceNum}: ${r.method} → ${r.status}`
            : `• Item ${r.sequenceNum}: :x: ${r.error ?? `HTTP ${r.status}`}`;

          if (totalLength + line.length + 1 > MAX_MESSAGE_LENGTH) {
            const remaining = itemResults.length - resultLines.length;
            resultLines.push(`_…and ${remaining} more item${remaining > 1 ? "s" : ""}_`);
            break;
          }
          resultLines.push(line);
          totalLength += line.length + 1;
        }

        const fullMessage = resultLines.length > 0
          ? `${summaryHeader}\n\n${resultLines.join("\n")}`
          : summaryHeader;

        await slackClient.chat.postMessage({
          channel: approval.requestedInChannel,
          thread_ts: approval.requestedInThread,
          text: fullMessage,
        });

        logger.info("Posted execution results to original thread", {
          approvalId,
          channel: approval.requestedInChannel,
          thread: approval.requestedInThread,
        });
      } catch (replyErr) {
        logger.warn("Failed to post results to original thread", {
          approvalId,
          error: replyErr instanceof Error ? replyErr.message : String(replyErr),
        });
      }
    }

    return { ok: true };
  } catch (err) {
    logger.error("executeBatchProposal failed", {
      approvalId,
      error: err instanceof Error ? err.message : String(err),
    });

    try {
      await db
        .update(approvals)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(approvals.id, approvalId));
    } catch { /* non-critical */ }

    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ── HTTP Request Executor ────────────────────────────────────────────────────

async function executeHttpRequest(args: {
  method: string;
  url: string;
  body?: any;
  headers?: Record<string, string>;
  credential?: ResolvedCredentialAuth | null;
}): Promise<{ ok: boolean; status?: number; body?: any; error?: string }> {
  const { method, url, body, headers, credential } = args;

  try {
    if (await isPrivateUrl(url)) {
      return { ok: false, error: `Blocked: URL resolves to a private/internal address` };
    }

    const injected = injectCredentialAuth(url, headers, credential);
    const requestHeaders = injected.headers;
    const requestUrl = injected.url;

    const fetchOptions: RequestInit = {
      method,
      headers: requestHeaders,
    };

    if (body && method !== "GET" && method !== "HEAD") {
      fetchOptions.body = JSON.stringify(body);
      if (!requestHeaders["Content-Type"]) {
        requestHeaders["Content-Type"] = "application/json";
      }
    }

    const response = await fetch(requestUrl, fetchOptions);
    const responseText = await response.text();
    let responseBody: any;
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = responseText;
    }

    // Retry on 429/503
    if (response.status === 429 || response.status === 503) {
      const retryAfter = response.headers.get("Retry-After");
      const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000;
      logger.info("executeHttpRequest: retrying after rate limit", {
        url,
        status: response.status,
        delayMs,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      // Retry once
      const retryResponse = await fetch(requestUrl, fetchOptions);
      const retryText = await retryResponse.text();
      let retryBody: any;
      try {
        retryBody = JSON.parse(retryText);
      } catch {
        retryBody = retryText;
      }
      return {
        ok: retryResponse.ok,
        status: retryResponse.status,
        body: retryBody,
        error: retryResponse.ok ? undefined : `HTTP ${retryResponse.status}`,
      };
    }

    return {
      ok: response.ok,
      status: response.status,
      body: responseBody,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}

// ── Update Approval Card ─────────────────────────────────────────────────────

async function updateApprovalCard(
  slackClient: WebClient,
  approval: Approval,
  status: "executing" | "completed" | "failed",
  errorMessage?: string,
  completed?: number,
  failed?: number,
  total?: number,
): Promise<void> {
  if (!approval.slackChannel || !approval.slackMessageTs) {
    return;
  }

  const completedCount = completed ?? approval.completedItems;
  const failedCount = failed ?? approval.failedItems;
  const totalCount = total ?? approval.totalItems;

  let color = COLOR_EXECUTING;
  let statusEmoji = ":hourglass_flowing_sand:";
  let statusText = "Executing";

  if (status === "completed") {
    color = failedCount > 0 ? "#e8912d" : COLOR_COMPLETED;
    statusEmoji = failedCount > 0 ? "⚠️" : "✅";
    statusText = failedCount > 0
      ? `Completed with ${failedCount} failure${failedCount > 1 ? "s" : ""}`
      : "Completed successfully";
  } else if (status === "failed") {
    color = COLOR_FAILED;
    statusEmoji = "❌";
    statusText = errorMessage ?? "Execution failed";
  }

  const progressText = `${completedCount + failedCount} / ${totalCount} items processed`;

  const attachmentBlocks: any[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${statusEmoji} ${approval.title}*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: approval.description ?? progressText,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${statusText} · ${progressText}${failedCount > 0 ? ` · ${failedCount} failed` : ""}`,
        },
      ],
    },
  ];

  try {
    await slackClient.chat.update({
      channel: approval.slackChannel,
      ts: approval.slackMessageTs,
      text: `${statusEmoji} ${approval.title} — ${statusText}`,
      attachments: [
        {
          color,
          blocks: attachmentBlocks,
        },
      ],
    });
  } catch (err) {
    logger.warn("updateApprovalCard: failed to update Slack message", {
      error: err instanceof Error ? err.message : String(err),
      approvalId: approval.id,
    });
  }
}
