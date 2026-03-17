import { AsyncLocalStorage } from "node:async_hooks";
import { tool, type Tool } from "ai";
import type { ZodType } from "zod";
import { checkAccess, getCredentialForApproval, getApprovers, getApprovalChannel } from "./approval.js";
import { logger } from "./logger.js";
import { WebClient } from "@slack/web-api";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { approvals } from "@aura/db/schema";

// ── Execution Context (AsyncLocalStorage) ────────────────────────────────────

export interface ExecutionContext {
  triggeredBy: string;
  triggerType: "user_message" | "scheduled_job" | "autonomous";
  jobId?: string;
  channelId?: string;
  threadTs?: string;
}

export const executionContext = new AsyncLocalStorage<ExecutionContext>();

// ── Slack Card Metadata ──────────────────────────────────────────────────────
// Co-located with tool definitions via defineTool() so that Slack card behavior
// (spinner label, input summary, output summary, URL citations) stays in sync
// with the tool itself instead of drifting in separate switch blocks.

export interface SlackToolMetadata<TInput = any, TOutput = any> {
  /** Spinner label shown while tool is running. Can be static, sync, or async. */
  status: string | ((input: TInput) => string | Promise<string>);
  /** Extract a short detail from input args for the in-progress card */
  detail?: (input: TInput) => string | undefined;
  /** Extract a short summary from result for the completed card */
  output?: (result: TOutput) => string | undefined;
  /** Extract URL citations for web tool cards */
  sources?: (
    result: TOutput,
  ) => Array<{ type: "url"; url: string; text: string }> | undefined;
}

/**
 * Retrieve the Slack card metadata from a tool, if it was created with
 * defineTool(). Returns undefined for tools created with the standard
 * AI SDK tool() helper.
 */
export function getSlackMeta(t: unknown): SlackToolMetadata | undefined {
  if (t && typeof t === "object" && "slack" in t) {
    return (t as { slack: SlackToolMetadata }).slack;
  }
  return undefined;
}

/**
 * Retrieve the user-facing description from a tool definition, if present.
 */
export function getToolDescription(t: unknown): string | undefined {
  if (t && typeof t === "object" && "description" in t) {
    const description = (t as { description?: unknown }).description;
    return typeof description === "string" ? description : undefined;
  }
  return undefined;
}

/**
 * Mutable name ref stored in a closure so registerToolNames() can fill it
 * in after the tools map is built.
 */
interface ToolNameRef {
  name?: string;
}

/**
 * Wrapper around AI SDK's tool() that co-locates Slack card metadata with the
 * tool definition and adds Nova's HTTP governance checks for sensitive calls.
 */
export function defineTool<TInput, TOutput>(config: {
  description: string;
  inputSchema: ZodType<TInput, any, any>;
  execute: (input: TInput) => PromiseLike<TOutput>;
  slack?: SlackToolMetadata<TInput, TOutput>;
  toModelOutput?: Tool<TInput, TOutput>["toModelOutput"];
}) {
  const { slack, ...rest } = config;
  const originalExecute = rest.execute;

  const toolRef: ToolNameRef = {};

  // Wrapped execute that handles governance
  const governedExecute = async (input: TInput): Promise<TOutput> => {
    const toolName = toolRef.name || "unknown";
    const ctx = executionContext.getStore() ?? {
      triggeredBy: "unknown",
      triggerType: "autonomous" as const,
    };

    // Only http_request needs approval gating
    if (toolName === "http_request") {
      try {
        const httpInput = input as Record<string, unknown>;
        const credentialName = httpInput.credential_name as string | undefined;
        const method = (httpInput.method as string | undefined) ?? "GET";
        const url = httpInput.url as string | undefined ?? "";
        const credentialOwner = httpInput.credential_owner as string | undefined ?? ctx.triggeredBy;

        // If no credential, default to auto-approve for GET, require approval otherwise
        if (!credentialName || !credentialOwner) {
          if (method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD" || method.toUpperCase() === "OPTIONS") {
            return originalExecute(input);
          } else {
            throw new Error("Write requests require a credential for governance");
          }
        }

        // Look up credential
        const credential = await getCredentialForApproval(credentialName, credentialOwner);
        if (!credential) {
          throw new Error(`Credential "${credentialName}" not found`);
        }

        // Check access
        const action = checkAccess(credential, ctx.triggeredBy, method);

        // Handle deny action
        if (action === "denied") {
          throw new Error(`Access denied: you don't have permission to use credential "${credentialName}"`);
        }

        // Handle auto-approve action
        if (action === "auto_approve") {
          return originalExecute(input);
        }

        // Handle require_approval action
        if (action === "require_approval") {
          const reason = httpInput.reason as string | undefined;
          let urlPath: string;
          try { urlPath = new URL(url).pathname; } catch { urlPath = url.split("?")[0]; }
          const shortPath = urlPath.length > 60 ? urlPath.slice(0, 57) + "..." : urlPath;
          const approvalTitle = `${method} ${shortPath} via ${credentialName}`;

          const approvalMetadata = JSON.stringify({
            type: "http_request",
            method,
            url,
            body: httpInput.body ?? null,
            headers: (httpInput.headers as Record<string, string> | undefined) ?? null,
            credentialKey: credentialName,
            credentialOwner,
            reason: reason ?? null,
          });

          const [approval] = await db
            .insert(approvals)
            .values({
              title: approvalTitle,
              description: approvalMetadata,
              credentialKey: credentialName,
              credentialOwner,
              urlPattern: url.split("?")[0],
              httpMethod: method,
              totalItems: 1,
              requestedBy: ctx.triggeredBy,
              requestedInChannel: ctx.channelId ?? null,
              requestedInThread: ctx.threadTs ?? null,
            })
            .returning({ id: approvals.id });

          const approvalId = approval.id;
          const approverIds = getApprovers(credential);
          const approverMentions = approverIds.map((id) => `<@${id}>`).join(", ");
          const approvalChannel = getApprovalChannel(credential);
          const targetChannel = approvalChannel ?? ctx.channelId ?? process.env.AURA_DEFAULT_CHANNEL;

          if (targetChannel) {
            const bodyPreview = httpInput.body
              ? JSON.stringify(httpInput.body).slice(0, 500)
              : null;
            const descLines = [
              reason ?? `\`${method}\` ${url}`,
              `• Credential: \`${credentialName}\``,
            ];
            if (bodyPreview) {
              descLines.push(`• Body: \`${bodyPreview}${bodyPreview.length >= 500 ? "…" : ""}\``);
            }

            const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
            const resp = await slackClient.chat.postMessage({
              channel: targetChannel,
              ...(ctx.threadTs ? { thread_ts: ctx.threadTs } : {}),
              text: "",
              attachments: [{
                color: "#e8912d",
                blocks: [
                  { type: "section", text: { type: "mrkdwn", text: `*🔒 ${approvalTitle}*` } },
                  { type: "section", text: { type: "mrkdwn", text: descLines.join("\n") } },
                  {
                    type: "actions",
                    elements: [
                      { type: "button", text: { type: "plain_text", text: "✅ Approve", emoji: true }, style: "primary", action_id: `approval_approve_${approvalId}`, value: approvalId },
                      { type: "button", text: { type: "plain_text", text: "❌ Reject", emoji: true }, style: "danger", action_id: `approval_reject_${approvalId}`, value: approvalId },
                    ],
                  },
                  { type: "context", elements: [{ type: "mrkdwn", text: `\`write\` · requested by <@${ctx.triggeredBy}> · ${approverMentions || "admins"}` }] },
                ],
              }],
              metadata: { event_type: "approval_request", event_payload: { approval_id: approvalId } },
            });

            await db
              .update(approvals)
              .set({ slackMessageTs: resp.ts ?? "", slackChannel: resp.channel ?? targetChannel })
              .where(eq(approvals.id, approvalId));
          }

          return {
            status: "awaiting_approval",
            proposal_id: approvalId,
            message: "This request has been submitted for approval. I'll execute it once approved.",
          } as TOutput;
        }

        // Default: auto-approve
        return originalExecute(input);
      } catch (err) {
        logger.warn("Governance check failed, failing closed (denying)", {
          toolName,
          error: err,
        });
        throw err;
      }
    }

    // All other tools execute without approval
    return originalExecute(input);
  };

  const toolConfig: Record<string, unknown> = {
    description: rest.description,
    inputSchema: rest.inputSchema,
    execute: governedExecute,
  };

  if (rest.toModelOutput) {
    toolConfig.toModelOutput = rest.toModelOutput;
  }

  const t = tool<TInput, TOutput>(
    toolConfig as unknown as Tool<TInput, TOutput>,
  );
  if (slack) {
    (t as any).slack = slack;
  }
  (t as any).__toolRef = toolRef;

  return t as Tool<TInput, TOutput> & {
    slack?: SlackToolMetadata<TInput, TOutput>;
  };
}

/**
 * Stamp tool names from the map keys onto each tool's internal ref.
 * Call this on the tools record after building it so the governance
 * interceptor knows which tool is being invoked.
 *
 * Handles both defineTool()-created tools (have __toolRef) and
 * plain AI SDK tools (skipped silently).
 */
export function registerToolNames<T extends Record<string, unknown>>(
  tools: T,
): T {
  for (const [name, t] of Object.entries(tools)) {
    if (t && typeof t === "object" && "__toolRef" in t) {
      (t as any).__toolRef.name = name;
    }
  }
  return tools;
}

/**
 * Build a toModelOutput result for tools that return binary content (images, PDFs, etc).
 * Converts base64 strings into native AI SDK content parts so the LLM can see the file.
 */
export function binaryToModelOutput(opts: {
  base64: string;
  mimeType: string;
  filename?: string;
  meta?: Record<string, unknown>;
}): {
  type: "content";
  value: Array<
    | { type: "text"; text: string }
    | { type: "image-data"; data: string; mediaType: string }
    | { type: "file-data"; data: string; mediaType: string; filename?: string }
  >;
} {
  const parts: Array<
    | { type: "text"; text: string }
    | { type: "image-data"; data: string; mediaType: string }
    | { type: "file-data"; data: string; mediaType: string; filename?: string }
  > = [];

  if (opts.meta && Object.keys(opts.meta).length > 0) {
    parts.push({
      type: "text",
      text: JSON.stringify({
        ...opts.meta,
        note: "Binary content attached as native file below",
      }),
    });
  }

  if (opts.mimeType?.startsWith("image/")) {
    parts.push({
      type: "image-data",
      data: opts.base64,
      mediaType: opts.mimeType,
    });
  } else {
    parts.push({
      type: "file-data",
      data: opts.base64,
      mediaType: opts.mimeType || "application/octet-stream",
      filename: opts.filename,
    });
  }

  return { type: "content", value: parts };
}
