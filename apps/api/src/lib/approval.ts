import { WebClient } from "@slack/web-api";
import { eq, and, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  actionLog,
  approvalPolicies,
  jobs,
  type ApprovalPolicy,
  type ScheduleContext,
} from "@aura/db/schema";
import { logger } from "./logger.js";

export type { ApprovalPolicy };

// ── Types ───────────────────────────────────────────────────────────────────

export interface ExecutionContext {
  userId?: string;
  channelId?: string;
  threadTs?: string;
  jobId?: string;
  triggerType: "user_message" | "scheduled_job" | "autonomous";
}

// ── URL Pattern Matching ────────────────────────────────────────────────────

/**
 * Simple glob matcher for URL patterns.
 * Supports `*` (match one path segment) and `**` (match any number of segments).
 * Strips protocol from both pattern and URL before matching.
 */
function matchUrlPattern(pattern: string, url: string): boolean {
  const stripProtocol = (s: string) => s.replace(/^https?:\/\//, "");
  const normalizedUrl = stripProtocol(url).replace(/\/$/, "");
  const normalizedPattern = stripProtocol(pattern).replace(/\/$/, "");

  const regexStr = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§")
    .replace(/\*/g, "[^/]+")
    .replace(/§§/g, ".*");

  return new RegExp(`^${regexStr}$`).test(normalizedUrl);
}

/**
 * Compute a specificity score for a pattern so more specific matches win.
 * Fewer wildcards and more literal segments = higher specificity.
 */
function patternSpecificity(pattern: string): number {
  const stripped = pattern.replace(/^https?:\/\//, "");
  const segments = stripped.split("/");
  let score = 0;
  for (const seg of segments) {
    if (seg === "**") score += 0;
    else if (seg.includes("*")) score += 1;
    else score += 2;
  }
  return score;
}

// ── Default Risk Tier by HTTP Method ────────────────────────────────────────

const METHOD_DEFAULT_TIER: Record<string, "read" | "write" | "destructive"> = {
  GET: "read",
  HEAD: "read",
  OPTIONS: "read",
  POST: "write",
  PUT: "write",
  PATCH: "write",
  DELETE: "destructive",
};

// ── Policy Lookup ───────────────────────────────────────────────────────────

export async function lookupPolicy(args: {
  toolName: string;
  url?: string;
  method?: string;
  credentialName?: string;
}): Promise<ApprovalPolicy | null> {
  const rows = await db.select().from(approvalPolicies);

  const candidates: Array<{ policy: ApprovalPolicy; specificity: number }> = [];

  for (const policy of rows) {
    if (args.toolName === "http_request") {
      if (policy.urlPattern && args.url) {
        if (!matchUrlPattern(policy.urlPattern, args.url)) continue;

        if (
          policy.httpMethods &&
          policy.httpMethods.length > 0 &&
          args.method &&
          !policy.httpMethods.includes(args.method.toUpperCase())
        ) {
          continue;
        }

        if (
          policy.credentialName &&
          args.credentialName &&
          policy.credentialName !== args.credentialName
        ) {
          continue;
        }

        candidates.push({
          policy,
          specificity: patternSpecificity(policy.urlPattern),
        });
      } else if (policy.toolPattern === "http_request") {
        candidates.push({ policy, specificity: 0 });
      }
    } else {
      if (policy.toolPattern === args.toolName) {
        candidates.push({ policy, specificity: 100 });
      }
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.specificity - a.specificity);
  return candidates[0].policy;
}

/**
 * Determine the effective risk tier for a tool invocation.
 * If a policy matches, use its tier. Otherwise fall back to method-based defaults
 * for http_request, or "write" for named tools.
 */
export function effectiveRiskTier(
  policy: ApprovalPolicy | null,
  method?: string,
): "read" | "write" | "destructive" {
  if (policy) return policy.riskTier as "read" | "write" | "destructive";
  if (method) return METHOD_DEFAULT_TIER[method.toUpperCase()] ?? "write";
  return "write";
}

function truncateValue(v: string, max = 200): string {
  return v.length <= max ? v : `${v.slice(0, max)}...`;
}

function renderScalar(v: unknown): string {
  if (v == null) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return truncateValue(JSON.stringify(v), 160);
}

function summarizeHttpRequest(params: Record<string, unknown>): string {
  const method = String(params.method ?? "GET").toUpperCase();
  const url = String(params.url ?? "(missing URL)");
  const bodyRaw = params.body;
  const body =
    typeof bodyRaw === "string"
      ? bodyRaw
      : bodyRaw != null
        ? JSON.stringify(bodyRaw)
        : "";
  const bodyLine = body
    ? `\n*Body (first 200 chars):*\n\`\`\`${truncateValue(body, 200)}\`\`\``
    : "";
  return `*Method:* \`${method}\`\n*URL:* ${url}${bodyLine}`;
}

function summarizeToolParams(toolName: string, params: unknown): string {
  if (toolName === "http_request" && params && typeof params === "object") {
    return summarizeHttpRequest(params as Record<string, unknown>);
  }

  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return `*Arguments:* \`${renderScalar(params)}\``;
  }

  const entries = Object.entries(params as Record<string, unknown>).slice(0, 12);
  if (entries.length === 0) return "*Arguments:* _(none)_";

  const lines = entries.map(([k, v]) => `- *${k}:* \`${truncateValue(renderScalar(v), 180)}\``);
  const hasMore = Object.keys(params as Record<string, unknown>).length > entries.length;
  if (hasMore) lines.push("- _...additional fields omitted_");
  return lines.join("\n");
}

// ── Request Approval (post Slack message + write action_log row) ────────────

export async function requestApproval(args: {
  actionLogId: string;
  toolName: string;
  params: unknown;
  riskTier: string;
  policy: ApprovalPolicy | null;
  context: ExecutionContext;
  slackClient?: InstanceType<typeof import("@slack/web-api").WebClient> | null;
  conversationContext?: string;
  credentialDescription?: string;
}): Promise<{ ts: string; channelId: string } | null> {
  const { actionLogId, toolName, params, riskTier, policy, context, slackClient: injectedSlackClient } = args;
  const slackClient = injectedSlackClient ?? new WebClient(process.env.SLACK_BOT_TOKEN);

  const row = await db
    .select()
    .from(actionLog)
    .where(eq(actionLog.id, actionLogId))
    .limit(1);

  const logEntry = row[0];
  if (!logEntry) {
    throw new Error(`action_log row ${actionLogId} not found`);
  }

  const channel = policy?.approvalChannel ?? undefined;
  const approvers = policy?.approverIds ?? [];
  const approverMentions =
    approvers.length > 0
      ? approvers.map((id) => `<@${id}>`).join(", ")
      : "admins";

  // ── Color coding by risk tier ──
  const RISK_COLORS: Record<string, string> = {
    write: "#e8912d",       // orange
    destructive: "#e01e5a", // red
    read: "#2eb67d",        // green
  };
  const borderColor = RISK_COLORS[riskTier] ?? "#e8912d";

  // ── Generate LLM summary (with fallback) ──
  let summary: ApprovalSummary | null = null;
  try {
    summary = await generateApprovalSummary({
      toolName,
      params: logEntry.params ?? params,
      conversationContext: args.conversationContext,
      credentialDescription: args.credentialDescription,
    });
  } catch (err) {
    logger.warn("Failed to generate approval summary", { error: err });
  }

  // Store summary in action_log if generated
  if (summary) {
    await db
      .update(actionLog)
      .set({ summary })
      .where(eq(actionLog.id, actionLogId));
  }

  // ── Build card title ──
  const cardTitle = summary?.title
    ? `🔒 ${summary.title}`
    : `🔒 Approval Required: ${toolName}`;

  // ── Build card body ──
  const cardBody = summary?.body
    ? summary.body
    : summarizeToolParams(toolName, logEntry.params ?? params);

  // ── Check if the triggering user is admin (for View raw button) ──
  const { isAdmin } = await import("./permissions.js");
  const showViewRaw = isAdmin(context.userId) || isAdmin(logEntry.triggeredBy);

  // ── Build blocks inside attachment for colored border ──
  const attachmentBlocks: any[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${cardTitle}*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: cardBody,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ Approve", emoji: true },
          style: "primary" as const,
          action_id: `governance_approve_${actionLogId}`,
          value: actionLogId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ Reject", emoji: true },
          style: "danger" as const,
          action_id: `governance_reject_${actionLogId}`,
          value: actionLogId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "📋 View more", emoji: true },
          action_id: `governance_view_more_${actionLogId}`,
          value: actionLogId,
        },
        ...(showViewRaw
          ? [
              {
                type: "button",
                text: { type: "plain_text", text: "🔧 View raw", emoji: true },
                action_id: `governance_view_raw_${actionLogId}`,
                value: actionLogId,
              },
            ]
          : []),
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `\`${riskTier}\` · triggered by <@${logEntry.triggeredBy}> · ${logEntry.triggerType} · ${approverMentions}`,
        },
      ],
    },
  ];

  let targetChannel: string;

  if (channel) {
    targetChannel = channel;
  } else if (context.channelId) {
    targetChannel = context.channelId;
  } else {
    const dm = await slackClient.conversations.open({
      users: logEntry.triggeredBy,
    });
    targetChannel = dm.channel?.id ?? logEntry.triggeredBy;
  }

  const result = await slackClient.chat.postMessage({
    channel: targetChannel,
    ...(context.threadTs ? { thread_ts: context.threadTs } : {}),
    text: `Approval required: ${summary?.title ?? toolName} (${riskTier})`,
    attachments: [
      {
        color: borderColor,
        blocks: attachmentBlocks,
      },
    ],
    metadata: {
      event_type: "approval_request",
      event_payload: {
        action_log_id: actionLogId,
      },
    },
  });

  if (context.jobId) {
    await db
      .update(jobs)
      .set({
        approvalStatus: "awaiting_approval",
        pendingActionLogId: actionLogId,
      })
      .where(eq(jobs.id, context.jobId));
  }

  logger.info("Approval requested", {
    actionLogId,
    toolName,
    riskTier,
    channel: targetChannel,
    messageTs: result.ts,
    hasSummary: !!summary,
  });

  return result.ts ? { ts: result.ts, channelId: targetChannel } : null;
}

// ── Handle Approval Reaction ────────────────────────────────────────────────

export async function handleApprovalReaction(args: {
  actionLogId: string;
  reaction: string;
  reactorUserId: string;
  slackClient: InstanceType<typeof import("@slack/web-api").WebClient>;
}): Promise<void> {
  const { actionLogId, reaction, reactorUserId, slackClient } = args;

  const rows = await db
    .select()
    .from(actionLog)
    .where(eq(actionLog.id, actionLogId))
    .limit(1);

  const entry = rows[0];
  if (!entry) {
    logger.warn("handleApprovalReaction: action_log row not found", {
      actionLogId,
    });
    return;
  }

  if (entry.status !== "pending_approval") {
    logger.info("handleApprovalReaction: action already resolved", {
      actionLogId,
      currentStatus: entry.status,
    });
    return;
  }

  const policy = await lookupPolicy({
    toolName: entry.toolName,
    url:
      entry.toolName === "http_request"
        ? (entry.params as Record<string, unknown>)?.url as string
        : undefined,
    method:
      entry.toolName === "http_request"
        ? (entry.params as Record<string, unknown>)?.method as string
        : undefined,
  });

  const allowedApprovers = policy?.approverIds ?? [];
  const adminIds = (process.env.AURA_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const isAuthorized =
    allowedApprovers.length === 0
      ? adminIds.includes(reactorUserId)
      : allowedApprovers.includes(reactorUserId);

  if (!isAuthorized) {
    logger.warn("handleApprovalReaction: unauthorized reactor", {
      actionLogId,
      reactorUserId,
    });
    return;
  }

  const isApproved = reaction === "white_check_mark";
  const newStatus = isApproved ? "approved" : "rejected";

  // Atomic compare-and-set to prevent race condition (P0-1 fix)
  const updated = await db
    .update(actionLog)
    .set({
      status: newStatus,
      approvedBy: reactorUserId,
      approvedAt: new Date(),
    })
    .where(
      and(
        eq(actionLog.id, actionLogId),
        eq(actionLog.status, "pending_approval")
      )
    )
    .returning({ id: actionLog.id });

  if (updated.length === 0) {
    logger.info("handleApprovalReaction: action already processed by another approver", {
      actionLogId,
      reactorUserId,
    });
    return;
  }

  if (entry.jobId) {
    if (isApproved) {
      await db
        .update(jobs)
        .set({
          approvalStatus: null,
          pendingActionLogId: null,
          status: "pending",
        })
        .where(eq(jobs.id, entry.jobId));
    } else {
      await db
        .update(jobs)
        .set({
          approvalStatus: null,
          pendingActionLogId: null,
          status: "cancelled",
          result: `Rejected by <@${reactorUserId}>`,
        })
        .where(eq(jobs.id, entry.jobId));
    }
  }

  logger.info("Approval reaction handled", {
    actionLogId,
    reaction,
    newStatus,
    reactorUserId,
  });
}

// ── LLM-Generated Approval Summaries ────────────────────────────────────────

export interface ApprovalSummary {
  title: string;
  body: string;
}

/**
 * Generate a human-readable summary of a tool call for the approval card.
 * Uses the main LLM model with a 3-second timeout.
 * Returns null on any failure — the card falls back to raw params.
 */
export async function generateApprovalSummary(args: {
  toolName: string;
  params: unknown;
  conversationContext?: string;
  credentialDescription?: string;
}): Promise<ApprovalSummary | null> {
  try {
    const { generateText } = await import("ai");
    const { getMainModel } = await import("./ai.js");

    const { model } = await getMainModel();

    const paramStr = JSON.stringify(args.params, null, 2);
    const truncatedParams = paramStr.length > 3000 ? paramStr.slice(0, 3000) + "\n...(truncated)" : paramStr;

    const prompt = `You are summarizing a tool call for a human approval card in Slack.

Tool: ${args.toolName}
Parameters:
${truncatedParams}
${args.credentialDescription ? `\nCredential context: ${args.credentialDescription}` : ""}
${args.conversationContext ? `\nConversation context (last messages):\n${args.conversationContext}` : ""}

Respond with EXACTLY two lines:
TITLE: <one-line action summary, max 60 chars, e.g. "Update lead status to Qualified in Close CRM">
BODY: <key details in max 3 short lines separated by \\n, e.g. names, emails, values — no field IDs or UUIDs>

Rules:
- TITLE must be a plain-language description of what this action does
- BODY should extract the most important human-readable values (names, emails, amounts, statuses)
- Never include raw field IDs, UUIDs, or technical parameters
- If you can't determine readable values, summarize the operation type`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const result = await generateText({
        model,
        prompt,
        maxOutputTokens: 200,
        temperature: 0,
        abortSignal: controller.signal,
      });

      clearTimeout(timeout);

      const text = result.text.trim();
      const titleMatch = text.match(/^TITLE:\s*(.+)/m);
      const bodyMatch = text.match(/^BODY:\s*(.+)/ms);

      if (!titleMatch) return null;

      return {
        title: titleMatch[1].trim().slice(0, 80),
        body: bodyMatch ? bodyMatch[1].trim().slice(0, 300) : "",
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    logger.warn("generateApprovalSummary failed, falling back to raw params", { error: err });
    return null;
  }
}
