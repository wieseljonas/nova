import type { WebClient } from "@slack/web-api";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { actionLog } from "../db/schema.js";
import { logger } from "./logger.js";
import { logError } from "./error-logger.js";
import { createInteractiveAgent } from "./agents.js";
import { generateText, stepCountIs } from "ai";
import { getMainModel } from "./ai.js";

/**
 * Resume a conversation after tool approval using SDK-native message continuation.
 * 
 * This implements the SDK-native HITL pattern:
 * 1. Load saved message history from action_log.conversationState
 * 2. Append a tool-approval-response message granting approval
 * 3. Re-invoke the AI SDK with the full message history
 * 4. The SDK naturally executes the approved tool and continues the conversation
 * 
 * @param args Resumption parameters
 * @returns Success status
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

    // Retrieve the action log entry with conversation state
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
      return { ok: false, error: `Action status is ${entry.status}, expected 'approved'` };
    }

    const state = entry.conversationState;
    if (!state || !state.messages || !state.approvalId) {
      logger.warn("Cannot resume: missing conversation state or message history", { actionLogId });
      return { ok: false, error: "No conversation state available for resumption" };
    }

    logger.info("Resuming conversation after approval (SDK-native)", {
      actionLogId,
      toolName: entry.toolName,
      userId: state.userId,
      channelId: state.channelId,
      messageCount: state.messages.length,
    });

    // Build the approval response message
    const approvalResponseMessage = {
      role: "tool" as const,
      content: [
        {
          type: "tool-approval-response" as const,
          toolCallId: state.approvalId,
          approved: true,
        },
      ],
    };

    // Append approval to message history
    const resumptionMessages = [
      ...state.messages,
      approvalResponseMessage,
    ];

    // Re-create the agent with the same context
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

    // Resume the conversation by re-submitting messages with approval
    // The SDK will naturally execute the approved tool and continue
    const result = await generateText({
      model: (await getMainModel()).model,
      messages: resumptionMessages as any,
      tools,
      stopWhen: stepCountIs(10),
    });

    // Update action log with execution result
    await db
      .update(actionLog)
      .set({
        status: "executed",
        result: { text: result.text } as any,
      })
      .where(eq(actionLog.id, actionLogId));

    // Post the continuation to Slack
    const { formatForSlack } = await import("./format.js");
    const { safePostMessage } = await import("./slack-messaging.js");
    
    const responseText = result.text || "Tool executed successfully.";
    const formattedResponse = formatForSlack(responseText);
    
    await safePostMessage(slackClient, {
      channel: state.channelId,
      thread_ts: state.threadTs,
      text: formattedResponse,
    });

    logger.info("Conversation resumed successfully after approval", {
      actionLogId,
      toolName: entry.toolName,
      responseLength: responseText.length,
    });

    return { ok: true };

  } catch (err: any) {
    logger.error("Failed to resume conversation after approval", {
      actionLogId,
      error: err.message,
      stack: err.stack,
    });

    logError({
      errorName: "ConversationResumptionError",
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
 * When a destructive tool is rejected, we resume the conversation with
 * a rejection message so the LLM knows the tool wasn't executed.
 * 
 * @param args Rejection parameters
 * @returns Success status
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
