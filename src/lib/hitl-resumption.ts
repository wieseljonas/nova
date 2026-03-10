import type { WebClient } from "@slack/web-api";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { actionLog } from "../db/schema.js";
import { logger } from "./logger.js";
import { logError } from "./error-logger.js";
import { safePostMessage } from "./slack-messaging.js";
import { createInteractiveAgent } from "./agents.js";
import { executionContext } from "./tool.js";
import { streamText } from "ai";
import { formatForSlack } from "./format.js";

/**
 * Resume a conversation after tool approval.
 * 
 * This is the core HITL (Human-in-the-Loop) resumption logic. When a destructive
 * tool call requires approval, the conversation state is saved. After approval,
 * this function:
 * 
 * 1. Retrieves the saved conversation state
 * 2. Executes the approved tool
 * 3. Resumes the LLM conversation with the tool result injected
 * 4. Posts the continuation to Slack
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
    // P1-2 fix: Verify approver is authorized (admin check happens in handleApprovalReaction,
    // but we double-check here for defense in depth)
    const { isAdmin } = await import("../slack/home.js");
    if (!isAdmin(approvedBy)) {
      logger.warn("resumeConversationAfterApproval: unauthorized approver", {
        actionLogId,
        approvedBy,
      });
      return { ok: false, error: "Unauthorized: only admins can approve actions" };
    }

    // 1. Retrieve the action log entry with conversation state
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
    if (!state) {
      // Legacy approval without conversation state - can't resume
      logger.warn("Cannot resume: no conversation state saved", { actionLogId });
      return { ok: false, error: "No conversation state available for resumption" };
    }

    logger.info("Resuming conversation after approval", {
      actionLogId,
      toolName: entry.toolName,
      userId: state.userId,
      channelId: state.channelId,
    });

    // 2. Execute the approved tool
    // We need to re-execute the tool with the stored params.
    // The tool wrapper will see the approved status and execute normally.
    
    // Set up execution context
    const ctx = {
      triggeredBy: state.userId,
      triggerType: "user_message" as const,
      channelId: state.channelId,
      threadTs: state.threadTs,
      conversationState: {
        userMessage: state.userMessage,
        stablePrefix: state.stablePrefix,
        conversationContext: state.conversationContext,
        dynamicContext: state.dynamicContext,
        files: state.files,
        teamId: state.teamId,
        timezone: state.timezone,
        modelId: state.modelId,
        channelType: state.channelType,
      },
    };

    let toolResult: any;
    let toolError: any = null;

    try {
      // Execute the approved tool via the agent
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

      const tool = tools[entry.toolName];
      if (!tool) {
        throw new Error(`Tool ${entry.toolName} not found in agent tools`);
      }

      // P0-2 fix: Set _approvedActionId to bypass governance on re-execution
      const executionCtx = {
        ...ctx,
        _approvedActionId: actionLogId,
      };

      // Execute in the proper context so the tool wrapper can log it
      await executionContext.run(executionCtx, async () => {
        try {
          // @ts-ignore - We're calling the tool execute function directly
          toolResult = await tool.execute(entry.params);
        } catch (err) {
          toolError = err;
        }
      });

      if (toolError) {
        throw toolError;
      }

      // Update action log with result
      await db
        .update(actionLog)
        .set({
          status: "executed",
          result: toolResult,
        })
        .where(eq(actionLog.id, actionLogId));

      logger.info("Approved tool executed successfully", {
        actionLogId,
        toolName: entry.toolName,
      });

    } catch (err: any) {
      logger.error("Approved tool execution failed", {
        actionLogId,
        toolName: entry.toolName,
        error: err.message,
        stack: err.stack,
      });

      // P1-4 fix: Log detailed error server-side
      logError({
        errorName: "ApprovedToolExecutionError",
        errorMessage: err.message,
        errorCode: "hitl_approved_tool_failed",
        userId: state.userId,
        channelId: state.channelId,
        context: { actionLogId, toolName: entry.toolName, stack: err.stack },
      });

      // Update action log with failure
      await db
        .update(actionLog)
        .set({
          status: "failed",
          result: { error: err.message },
        })
        .where(eq(actionLog.id, actionLogId));

      // P1-4 fix: Send generic error message to user, not raw error
      await safePostMessage(slackClient, {
        channel: state.channelId,
        thread_ts: state.threadTs,
        text: `The approved action failed to execute. The error has been logged for review.`,
      });

      return { ok: false, error: "Tool execution failed" };
    }

    // 3. Resume the LLM conversation with the tool result
    // Build a synthetic tool call result message to inject into the conversation
    const toolCallMessage = {
      role: "assistant" as const,
      content: [
        {
          type: "tool-call" as const,
          toolCallId: `approved-${actionLogId}`,
          toolName: entry.toolName,
          args: entry.params,
        },
      ],
    };

    const toolResultMessage = {
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: `approved-${actionLogId}`,
          toolName: entry.toolName,
          result: toolResult,
        },
      ],
    };

    // Continue the conversation with the tool result injected
    try {
      const { agent } = await createInteractiveAgent({
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

      // Generate continuation with the tool result injected
      // We use a synthetic conversation that includes the approved tool call and its result
      const continuationPrompt = `[Tool call approved and executed]
Tool: ${entry.toolName}
Result: ${JSON.stringify(toolResult, null, 2).slice(0, 2000)}

Please continue the conversation acknowledging the tool result.`;

      const result = await agent.generate({
        prompt: continuationPrompt,
      });

      const responseText = result.text;

      // Post the continuation to Slack
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
      logger.error("Failed to resume conversation after tool execution", {
        actionLogId,
        error: err.message,
        stack: err.stack,
      });

      // P1-4 fix: Log detailed error with stack trace
      logError({
        errorName: "ConversationResumptionError",
        errorMessage: err.message,
        errorCode: "hitl_resumption_failed",
        userId: state.userId,
        channelId: state.channelId,
        context: { actionLogId, toolName: entry.toolName, stack: err.stack },
      });

      // P1-4 fix: Generic message to user, detailed result but no raw error
      await safePostMessage(slackClient, {
        channel: state.channelId,
        thread_ts: state.threadTs,
        text: `The approved action completed, but I had trouble generating a follow-up response. You can check the action logs for details.`,
      });

      return { ok: false, error: "Conversation resumption failed" };
    }

  } catch (error: any) {
    logger.error("Resumption handler error", {
      actionLogId,
      error: error.message,
      stack: error.stack,
    });

    // P1-4 fix: Log detailed error with stack
    logError({
      errorName: "ResumptionHandlerError",
      errorMessage: error.message,
      errorCode: "hitl_resumption_handler_error",
      context: { actionLogId, stack: error.stack },
    });

    // P1-4 fix: Generic error message to caller
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
      // No conversation state - just acknowledge rejection
      logger.info("Tool rejected (no resumption needed)", {
        actionLogId,
        toolName: entry.toolName,
      });
      return { ok: true };
    }

    // Notify the user that the tool was rejected
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

    // P1-4 fix: Log detailed error
    logError({
      errorName: "RejectionHandlerError",
      errorMessage: error.message,
      errorCode: "hitl_rejection_handler_error",
      context: { actionLogId, stack: error.stack },
    });

    // P1-4 fix: Generic error message
    return { ok: false, error: "Failed to handle tool rejection" };
  }
}
