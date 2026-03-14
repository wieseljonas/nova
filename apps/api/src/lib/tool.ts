import { AsyncLocalStorage } from "node:async_hooks";
import { tool, type Tool } from "ai";
import { eq } from "drizzle-orm";
import type { ZodType } from "zod";
import { db } from "../db/client.js";
import { lookupPolicy, effectiveRiskTier, type ApprovalPolicy } from "./approval.js";
import { logger } from "./logger.js";
import { generateProposalSummary } from "./proposal-summary.js";

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
 * tool definition and adds SDK-native needsApproval governance + action logging.
 *
 * Tools with write/destructive risk tier use `needsApproval` to pause for
 * human approval. The SDK emits a `tool-approval-request` output part, and
 * respond.ts saves conversation state for resumption.
 *
 * Read-tier tools execute immediately with action logging.
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

        // Check credential-level allowed methods
        const credentialOwner = httpInput.credential_owner as string | undefined ?? ctx.triggeredBy;
        if (credentialName && credentialOwner) {
          const { getCredentialMethods } = await import("./api-credentials.js");
          const allowedMethods = await getCredentialMethods(credentialName, credentialOwner);
          if (allowedMethods && allowedMethods.length > 0) {
            const methodUpper = method.toUpperCase();
            if (allowedMethods.map(m => m.toUpperCase()).includes(methodUpper)) {
              // Method is in the allowed list, skip approval
              return originalExecute(input);
            }
          }
        }

        const policy = await lookupPolicy({
          toolName,
          url,
          method,
          credentialName,
        });

        const { effectiveAction } = await import("./approval.js");
        const action = effectiveAction(policy, method);

        // Handle deny action
        if (action === "deny") {
          throw new Error(`Action denied by governance policy: ${policy?.name ?? "default"}`);
        }

        // Handle auto-approve action
        if (action === "auto_approve") {
          return originalExecute(input);
        }

        // Handle require_approval action
        if (action === "require_approval") {
          const { createProposal } = await import("./batch-executor.js");
          const summary = await generateProposalSummary({
            credentialName,
            method,
            url,
            body: httpInput.body,
            itemCount: 1,
            reason: httpInput.reason,
          });
          const result = await createProposal({
            title: summary.title,
            description: summary.description,
            credentialName,
            items: [{
              method,
              url,
              body: httpInput.body,
              headers: httpInput.headers as Record<string, string> | undefined,
            }],
            requestedBy: ctx.triggeredBy,
            requestedInChannel: ctx.channelId,
            requestedInThread: ctx.threadTs,
          });

          if (!result.ok) {
            throw new Error(`Failed to create approval proposal: ${result.error}`);
          }

          // Return a special message to the LLM indicating approval is pending
          return {
            status: "awaiting_approval",
            proposal_id: result.approvalId,
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
