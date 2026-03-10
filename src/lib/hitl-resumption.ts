import type { WebClient } from "@slack/web-api";
import { eq } from "drizzle-orm";
import { generateText } from "ai";
import { db } from "../db/client.js";
import { actionLog } from "../db/schema.js";
import { logger } from "./logger.js";
import { logError } from "./error-logger.js";
import { executionContext } from "./tool.js";

/**
 * Resume a conversation after tool approval using SDK-native message replay.
 *
 * When a tool with needsApproval=true is called, the SDK emits a
 * tool-approval-request. respond.ts saves the full conversation messages
 * and context to action_log. After approval:
 *
 * 1. Load the saved messages from action_log.conversationState
 * 2. Append a tool-approval-response message (approved: true)
 * 3. Re-invoke generateText with the full message history
 * 4. The SDK executes the tool naturally and continues the conversation
 * 5. Post the result to Slack
 */
export async function resumeConversationAfterApproval(args: {
  actionLogId: string;
  approvedBy: string;
  slackClient: WebClient;
}): Promise<{ ok: boolean; error?: string }> {
  const { actionLogId, approvedBy, slackClient } = args;

  try {
    // Verify approver is authorized
    const { isAdmin } = await import("../slack/home.js");
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
      return { ok: false, error: `Action is in ${entry.status} state, not approved` };
    }

    const state = entry.conversationState;
    if (!state?.messages || !state.toolCallId) {
      logger.warn("resumeConversationAfterApproval: no conversation state or toolCallId", {
        actionLogId,
        hasState: !!state,
        hasMessages: !!state?.messages,
        hasToolCallId: !!state?.toolCallId,
      });
      return { ok: false, error: "No conversation state for resumption" };
    }

    logger.info("HITL resumption: starting", {
      actionLogId,
      approvedBy,
      toolName: entry.toolName,
      toolCallId: state.toolCallId,
      messageCount: state.messages.length,
    });

    // 2. Build the approval response message
    const approvalMessage = {
      role: "tool" as const,
      content: [
        {
          type: "tool-approval-response" as const,
          toolCallId: state.toolCallId,
          approved: true,
        },
      ],
    };

    const messages = [...state.messages, approvalMessage];

    // 3. Recreate the agent context and call generateText
    const { createInteractiveAgent } = await import("./agents.js");
    const { agent } = await createInteractiveAgent({
      slackClient,
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
        return await agent.generate({
          messages: messages as any,
        });
      },
    );

    // 4. Post the result to Slack
    const { formatForSlack } = await import("./format.js");
    const { safePostMessage } = await import("./slack-messaging.js");

    const responseText = result.text;
    if (responseText) {
      await safePostMessage(slackClient, {
        channel: state.channelId,
        thread_ts: state.threadTs,
        text: formatForSlack(responseText),
      });
    }

    // Update action_log with the result
    try {
      await db
        .update(actionLog)
        .set({
          result: { text: responseText, resumedBy: approvedBy } as any,
        })
        .where(eq(actionLog.id, actionLogId));
    } catch { /* non-critical */ }

    logger.info("HITL resumption: completed successfully", {
      actionLogId,
      toolName: entry.toolName,
      responseLength: responseText?.length ?? 0,
    });

    return { ok: true };
  } catch (err: any) {
    logger.error("HITL resumption failed", {
      actionLogId,
      error: err.message,
      stack: err.stack,
    });

    logError({
      errorName: "HITLResumptionError",
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
