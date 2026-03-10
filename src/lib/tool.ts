import { AsyncLocalStorage } from "node:async_hooks";
import { tool, type Tool } from "ai";
import { eq } from "drizzle-orm";
import type { ZodType } from "zod";
import { db } from "../db/client.js";
import { actionLog } from "../db/schema.js";
import { lookupPolicy, requestApproval, effectiveRiskTier, type ApprovalPolicy } from "./approval.js";
import { logger } from "./logger.js";

// ── Execution Context (AsyncLocalStorage) ────────────────────────────────────

export interface ExecutionContext {
  triggeredBy: string;
  triggerType: "user_message" | "scheduled_job" | "autonomous";
  jobId?: string;
  channelId?: string;
  threadTs?: string;
  // HITL resumption: if set, this tool execution is pre-approved and should bypass governance (P0-2 fix)
  _approvedActionId?: string;
  // P1-3: toolCallId from AI SDK stream (if available)
  toolCallId?: string;
  // HITL resumption context - populated by pipeline when approval might be needed
  conversationState?: {
    userMessage: string;
    stablePrefix: string;
    conversationContext: string;
    dynamicContext?: string;
    files?: any[];
    teamId?: string;
    timezone?: string;
    modelId?: string;
    channelType?: string;
    previousMessages?: any[];
    toolCallId?: string;
  };
}

export const executionContext = new AsyncLocalStorage<ExecutionContext>();

// HITL: Separate storage for conversation state (populated by pipeline)
export const conversationStateStorage = new AsyncLocalStorage<ExecutionContext["conversationState"]>();

// ── PendingApprovalError ─────────────────────────────────────────────────────

export class PendingApprovalError extends Error {
  constructor(public readonly actionLogId: string) {
    super(`Action pending approval: ${actionLogId}`);
    this.name = "PendingApprovalError";
  }
}

// ── Slack Card Metadata ──────────────────────────────────────────────────────
// Co-located with tool definitions via defineTool() so that Slack card behavior
// (spinner label, input summary, output summary, URL citations) stays in sync
// with the tool itself instead of drifting in separate switch blocks.

export interface SlackToolMetadata<TInput = any, TOutput = any> {
  /** Spinner label shown while tool is running, e.g. "Searching the web..." */
  status: string;
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
 * Mutable name ref stored in a closure so registerToolNames() can fill it
 * in after the tools map is built.
 */
interface ToolNameRef {
  name?: string;
}

/**
 * Wrapper around AI SDK's tool() that co-locates Slack card metadata with the
 * tool definition and adds a governance interceptor. Every tool call is logged
 * to action_log; destructive-tier calls are gated behind approval.
 *
 * Usage:
 * ```ts
 * const myTool = defineTool({
 *   description: "...",
 *   inputSchema: z.object({ query: z.string() }),
 *   execute: async ({ query }) => ({ ok: true, results: [] }),
 *   slack: {
 *     status: "Searching...",
 *     detail: (input) => input.query,
 *     output: (result) => `${result.results.length} results`,
 *   },
 * });
 * ```
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

  const governedExecute = async (input: TInput): Promise<TOutput> => {
    const toolName = toolRef.name || "unknown";
    const ctx = executionContext.getStore() ?? {
      triggeredBy: "unknown",
      triggerType: "autonomous" as const,
    };
    
    // HITL: Merge conversation state from separate storage if available
    const conversationState = conversationStateStorage.getStore();
    if (conversationState && !ctx.conversationState) {
      (ctx as any).conversationState = conversationState;
    }

    // P0-2 fix: If this execution is pre-approved, bypass governance entirely
    if (ctx._approvedActionId) {
      logger.info("Governance: bypassing approval check for pre-approved action", {
        toolName,
        approvedActionId: ctx._approvedActionId,
      });
      return await originalExecute(input);
    }

    let riskTier: "read" | "write" | "destructive" = "write";
    let policy: ApprovalPolicy | null = null;

    try {
      const httpInput = input as Record<string, unknown>;
      const lookup = await lookupPolicy({
        toolName,
        url: toolName === "http_request" ? (httpInput.url as string) : undefined,
        method: toolName === "http_request" ? (httpInput.method as string) : undefined,
        credentialName: httpInput.credential_name as string | undefined,
      });
      policy = lookup;
      const httpInput2 = input as Record<string, unknown>;
      riskTier = effectiveRiskTier(policy, toolName === "http_request" ? (httpInput2.method as string) : undefined);
    } catch (policyErr) {
      logger.warn("Governance: policy lookup failed, defaulting to write tier", {
        toolName,
        error: policyErr,
      });
    }

    // Destructive: write pending log → post approval message → throw
    if (riskTier === "destructive") {
      const [logEntry] = await db
        .insert(actionLog)
        .values({
          toolName,
          params: input as any,
          triggerType: ctx.triggerType,
          triggeredBy: ctx.triggeredBy,
          jobId: ctx.jobId ?? null,
          credentialName: (input as any)?.credential_name ?? null,
          riskTier,
          status: "pending_approval",
          // Store conversation state for resumption (if available)
          conversationState: ctx.conversationState ? {
            channelId: ctx.channelId || "",
            threadTs: ctx.threadTs,
            userId: ctx.triggeredBy,
            channelType: ctx.conversationState.channelType || "dm",
            userMessage: ctx.conversationState.userMessage,
            stablePrefix: ctx.conversationState.stablePrefix,
            conversationContext: ctx.conversationState.conversationContext,
            dynamicContext: ctx.conversationState.dynamicContext,
            files: ctx.conversationState.files,
            teamId: ctx.conversationState.teamId,
            timezone: ctx.conversationState.timezone,
            modelId: ctx.conversationState.modelId,
            // P1-3 fix: Populate previousMessages and toolCallId
            previousMessages: ctx.conversationState.previousMessages,
            toolCallId: ctx.toolCallId,
          } : null,
        })
        .returning({ id: actionLog.id });

      const approvalMessageInfo = await requestApproval({
        actionLogId: logEntry.id,
        toolName,
        params: input,
        riskTier,
        policy: policy,
        context: ctx,
      });

      // Store approval message location for later reference
      if (approvalMessageInfo) {
        await db
          .update(actionLog)
          .set({
            approvalMessageTs: approvalMessageInfo.ts,
            approvalChannelId: approvalMessageInfo.channelId,
          })
          .where(eq(actionLog.id, logEntry.id));
      }

      throw new PendingApprovalError(logEntry.id);
    }

    // Read / Write: execute, then log result
    let logId: string | undefined;

    try {
      // Write the log entry before execution (captures params before credential injection)
      try {
        const [logEntry] = await db
          .insert(actionLog)
          .values({
            toolName,
            params: input as any,
            triggerType: ctx.triggerType,
            triggeredBy: ctx.triggeredBy,
            jobId: ctx.jobId ?? null,
            credentialName: (input as any)?.credential_name ?? null,
            riskTier,
            status: "executed",
          })
          .returning({ id: actionLog.id });
        logId = logEntry.id;
      } catch (logErr) {
        logger.warn("Governance: failed to write action_log entry", {
          toolName,
          error: logErr,
        });
      }

      const result = await originalExecute(input);

      // Update log with result
      if (logId) {
        try {
          await db
            .update(actionLog)
            .set({ result: result as any })
            .where(eq(actionLog.id, logId));
        } catch { /* non-critical */ }
      }

      return result;
    } catch (error: any) {
      // Update log with failure status
      if (logId) {
        try {
          await db
            .update(actionLog)
            .set({
              status: "failed",
              result: { error: error.message } as any,
            })
            .where(eq(actionLog.id, logId));
        } catch { /* non-critical */ }
      }
      throw error;
    }
  };

  const toolConfig = { ...rest, execute: governedExecute };
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
