import type { WebClient } from "@slack/web-api";
import { and, eq } from "drizzle-orm";
import { generateText, stepCountIs } from "ai";
import { db } from "../db/client.js";
import { actionLog } from "../db/schema.js";
import { logger } from "./logger.js";
import { logError } from "./error-logger.js";
import { executionContext } from "./tool.js";
import { isAdmin } from "./permissions.js";

/**
 * Resume a conversation after tool approval using SDK-native message replay.
 *
 * When a tool with needsApproval=true is called, the SDK emits a
 * tool-approval-request. respond.ts saves the full conversation messages
 * and context to action_log. After approval:
 *
 * 1. Load the saved messages from action_log.conversationState
 * 2. Append a tool-approval-response message (approved: true)
 * 3. Re-invoke generateText with the full message history + all tools
 * 4. The SDK executes the tool naturally and continues the conversation
 * 5. Update action_log status and post the result to Slack
 */
export async function resumeConversationAfterApproval(args: {
  actionLogId: string;
  approvedBy: string;
  slackClient: WebClient;
}): Promise<{ ok: boolean; error?: string }> {
  const { actionLogId, approvedBy, slackClient } = args;

  try {
    // Verify approver is authorized
    if (!isAdmin(approvedBy)) {
      logger.warn("resumeConversationAfterApproval: unauthorized approver", {
        actionLogId,
        approvedBy,
      });
      return { ok: false, error: "Unauthorized: only admins can approve actions" };
    }

    // 1. Load the action log entry with conversation state
    const rows = await db
      .select()
      .from(actionLog)
      .where(eq(actionLog.id, actionLogId))
      .limit(1);

    const entry = rows[0];
    if (!entry) {
      return { ok: false, error: "Action log entry not found" };
    }

    if (entry.status !== "approved") {
      logger.warn("resumeConversationAfterApproval: entry not in approved state", {
        actionLogId,
        status: entry.status,
      });
      return { ok: false, error: `Action status is ${entry.status}, expected 'approved'` };
    }

    const state = entry.conversationState;
    if (!state || !state.messages || !state.toolCallId) {
      return {
        ok: false,
        error: "Missing conversation state, messages, or toolCallId for resumption",
      };
    }

    // P1-2: Validate messages array structure before replay
    if (!Array.isArray(state.messages) || state.messages.length === 0) {
      return {
        ok: false,
        error: "Conversation state messages corrupted: not an array or empty",
      };
    }
    const invalidMessages = state.messages.filter(
      (m: any) => !m || typeof m !== "object" || !m.role,
    );
    if (invalidMessages.length > 0) {
      logger.error("HITL resumption: corrupted messages in conversation state", {
        actionLogId,
        invalidCount: invalidMessages.length,
      });
      // Post user-facing error
      const { safePostMessage } = await import("./slack-messaging.js");
      await safePostMessage(slackClient, {
        channel: state.channelId,
        thread_ts: state.threadTs,
        text: "⚠️ Approval expired — conversation state corrupted. Please retry your original request.",
      });
      return { ok: false, error: "Conversation state messages corrupted" };
    }

    if (!state.approvalId || !state.assistantToolCall) {
      logger.warn("HITL resumption: missing approvalId or assistantToolCall", {
        actionLogId,
        hasApprovalId: !!state.approvalId,
        hasAssistantToolCall: !!state.assistantToolCall,
      });
      const { safePostMessage } = await import("./slack-messaging.js");
      await safePostMessage(slackClient, {
        channel: state.channelId,
        thread_ts: state.threadTs,
        text: "⚠️ This approval was created before the conversation state fix was deployed. Please retry your original request.",
      });
      return { ok: false, error: "Missing approvalId or assistantToolCall in conversation state" };
    }

    logger.info("HITL resumption: starting", {
      actionLogId,
      toolName: entry.toolName,
      approvedBy,
      messageCount: state.messages.length,
    });

    // 2. Reconstruct the full message history for SDK replay
    // The SDK expects: user message -> assistant (with tool call + approval request) -> tool (approval response)
    // state.messages has the user input; state.assistantToolCall has the tool call details
    const assistantMessage = (state.assistantToolCall && state.approvalId) ? {
      role: "assistant" as const,
      content: [
        {
          type: "tool-call" as const,
          toolCallId: state.toolCallId,
          toolName: state.assistantToolCall.toolName,
          input: state.assistantToolCall.input,
        },
        {
          type: "tool-approval-request" as const,
          toolCallId: state.toolCallId,
          approvalId: state.approvalId,
        },
      ],
    } : null;

    const approvalMessage = {
      role: "tool" as const,
      content: [
        {
          type: "tool-approval-response" as const,
          approvalId: state.approvalId!,
          approved: true,
        },
      ],
    };

    const messages = [
      ...state.messages,
      ...(assistantMessage ? [assistantMessage] : []),
      approvalMessage,
    ];

    // 3. Recreate the agent to get tools, then use generateText with stepCountIs
    // We use generateText directly (not agent.generate) to set a tight step limit
    // for the resumption -- we only need the tool to execute + a follow-up response.
    const { createInteractiveAgent } = await import("./agents.js");
    const { getMainModel } = await import("./ai.js");
    const { agent, tools } = await createInteractiveAgent({
      slackClient,
      context: {
        userId: state.userId,
        channelId: state.channelId,
        threadTs: state.threadTs,
        timezone: state.timezone,
      },
      stablePrefix: state.stablePrefix,
      conversationContext: state.conversationContext,
      dynamicContext: state.dynamicContext,
    });

    // Run within execution context so tools know the trigger
    const result = await executionContext.run(
      {
        triggeredBy: state.userId,
        triggerType: "user_message",
        channelId: state.channelId,
        threadTs: state.threadTs,
      },
      async () => {
        const model = (await getMainModel()).model;
        return await generateText({
          model,
          messages: messages as any,
          tools,
          stopWhen: stepCountIs(10), // Safety limit: max 10 steps for resumption
        });
      },
    );

    // 4. Update action_log with execution result
    try {
      await db
        .update(actionLog)
        .set({
          status: "executed",
          result: { text: result.text, resumedBy: approvedBy } as any,
        })
        .where(eq(actionLog.id, actionLogId));
    } catch { /* non-critical */ }

    // 5. Post the result to Slack
    const { formatForSlack } = await import("./format.js");
    const { safePostMessage } = await import("./slack-messaging.js");

    const responseText = result.text || "Tool executed successfully.";
    await safePostMessage(slackClient, {
      channel: state.channelId,
      thread_ts: state.threadTs,
      text: formatForSlack(responseText),
    });

    logger.info("HITL resumption: completed successfully", {
      actionLogId,
      toolName: entry.toolName,
      responseLength: responseText.length,
    });

    return { ok: true };
  } catch (err: any) {
    logger.error("HITL resumption failed", {
      actionLogId,
      error: err.message,
      stack: err.stack,
    });

    // Update action_log to reflect failure
    try {
      await db
        .update(actionLog)
        .set({
          status: "failed",
          result: { error: err.message, resumedBy: approvedBy } as any,
        })
        .where(eq(actionLog.id, actionLogId));
    } catch { /* non-critical */ }

    logError({
      errorName: "HitlResumptionError",
      errorMessage: err.message,
      errorCode: "hitl_resumption_failed",
      context: { actionLogId, stack: err.stack },
    });

    return { ok: false, error: "Failed to resume conversation after approval" };
  }
}

/**
 * Handle rejection of a tool call.
 *
 * When a destructive tool is rejected, notify the user in the thread.
 */
export async function handleToolRejection(args: {
  actionLogId: string;
  rejectedBy: string;
  slackClient: WebClient;
}): Promise<{ ok: boolean; error?: string }> {
  const { actionLogId, rejectedBy, slackClient } = args;

  try {
    const rows = await db
      .select()
      .from(actionLog)
      .where(eq(actionLog.id, actionLogId))
      .limit(1);

    const entry = rows[0];
    if (!entry) {
      return { ok: false, error: "Action log entry not found" };
    }

    // Update status to rejected only if still pending_approval (atomic CAS)
    const updated = await db
      .update(actionLog)
      .set({ status: "rejected" })
      .where(
        and(
          eq(actionLog.id, actionLogId),
          eq(actionLog.status, "pending_approval"),
        ),
      )
      .returning({ id: actionLog.id });

    if (updated.length === 0) {
      logger.warn("Tool rejection skipped: action already resolved", {
        actionLogId,
        currentStatus: entry.status,
      });
      return { ok: false, error: "Action already resolved" };
    }

    const state = entry.conversationState;
    if (!state) {
      logger.info("Tool rejected (no resumption needed)", {
        actionLogId,
        toolName: entry.toolName,
      });
      return { ok: true };
    }

    // Notify the user that the tool was rejected
    const { safePostMessage } = await import("./slack-messaging.js");
    await safePostMessage(slackClient, {
      channel: state.channelId,
      thread_ts: state.threadTs,
      text: `The requested action (\`${entry.toolName}\`) was rejected by <@${rejectedBy}>. I won't proceed with that operation.`,
    });

    logger.info("Tool rejection handled", {
      actionLogId,
      toolName: entry.toolName,
      rejectedBy,
    });

    return { ok: true };

  } catch (error: any) {
    logger.error("Rejection handler error", {
      actionLogId,
      error: error.message,
      stack: error.stack,
    });

    logError({
      errorName: "RejectionHandlerError",
      errorMessage: error.message,
      errorCode: "hitl_rejection_handler_error",
      context: { actionLogId, stack: error.stack },
    });

    return { ok: false, error: "Failed to handle tool rejection" };
  }
}
