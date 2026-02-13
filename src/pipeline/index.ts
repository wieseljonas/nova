import type { WebClient } from "@slack/web-api";
import {
  buildMessageContext,
  shouldRespond,
  type MessageContext,
} from "./context.js";
import { assemblePrompt } from "./prompt.js";
import { generateResponse } from "./respond.js";
import { storeMessage } from "../memory/store.js";
import { extractMemories } from "../memory/extract.js";
import { getOrCreateProfile, recordInteraction, updateProfileFromConversation } from "../users/profiles.js";
import { logger } from "../lib/logger.js";
import type { KnownEventFromType } from "@slack/bolt";

interface PipelineOptions {
  event: KnownEventFromType<"message"> | KnownEventFromType<"app_mention">;
  client: WebClient;
  botUserId: string;
  /** Vercel waitUntil for background tasks */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * The main message pipeline — the core loop for every incoming message.
 *
 * Steps:
 * 1. Parse context (who, where, what)
 * 2. Decide if we should respond
 * 3. Assemble prompt (memories + profile + thread context)
 * 4. Call LLM
 * 5. Post-process and send response
 * 6. Background: store messages, extract memories, update profile
 */
export async function runPipeline(options: PipelineOptions): Promise<void> {
  const { event, client, botUserId, waitUntil } = options;
  const pipelineStart = Date.now();

  // 1. Parse context
  const context = buildMessageContext(event, botUserId);
  if (!context) {
    logger.debug("Skipped event — no valid context");
    return;
  }

  // 2. Should we respond?
  if (!shouldRespond(context)) {
    // Still store the message for context, but don't respond
    if (waitUntil) {
      waitUntil(storeUserMessage(context));
    }
    return;
  }

  logger.info("Processing message", {
    userId: context.userId,
    channelType: context.channelType,
    isDm: context.isDm,
    textPreview: context.text.substring(0, 80),
  });

  try {
    // Ensure user has a profile
    const displayName = await resolveDisplayName(client, context.userId);
    const profile = await getOrCreateProfile(
      context.userId,
      displayName,
    );

    // 3. Check for transparency commands first
    const transparencyResult = await handleTransparencyCommands(
      context,
      client,
    );
    if (transparencyResult) return;

    // 4. Assemble prompt
    const { systemPrompt, memories, userProfile } = await assemblePrompt(context);

    // 5. Call LLM
    const response = await generateResponse({
      systemPrompt,
      userMessage: context.text,
    });

    // 6. Send response to Slack
    await client.chat.postMessage({
      channel: context.channelId,
      text: response.formatted,
      thread_ts: context.threadTs || context.messageTs,
    });

    const totalMs = Date.now() - pipelineStart;
    logger.info(`Pipeline completed in ${totalMs}ms`, {
      userId: context.userId,
      channelType: context.channelType,
      memoriesUsed: memories.length,
      modifications: response.modifications,
    });

    // 7. Background tasks (via waitUntil so they don't block the response)
    const backgroundTasks = runBackgroundTasks({
      context,
      response: response.raw,
      displayName,
    });

    if (waitUntil) {
      waitUntil(backgroundTasks);
    } else {
      // If no waitUntil available, await them (but this adds latency)
      await backgroundTasks;
    }
  } catch (error) {
    logger.error("Pipeline failed", {
      error: String(error),
      userId: context.userId,
      channelId: context.channelId,
    });

    // Try to send a graceful error message
    try {
      await client.chat.postMessage({
        channel: context.channelId,
        text: "Sorry, I hit a snag processing that. Give me a sec and try again.",
        thread_ts: context.threadTs || context.messageTs,
      });
    } catch {
      // If we can't even send the error message, just log and move on
      logger.error("Failed to send error message to Slack");
    }
  }
}

/**
 * Handle transparency commands: "what do you know about me?" and "forget X"
 */
async function handleTransparencyCommands(
  context: MessageContext,
  client: WebClient,
): Promise<boolean> {
  const text = context.text.toLowerCase().trim();

  // "What do you know about me?" command
  if (
    text.includes("what do you know about me") ||
    text.includes("what do you remember about me")
  ) {
    // This will be fully implemented in M3
    // For now, return false to let the normal pipeline handle it
    return false;
  }

  // "Forget X" command
  if (text.startsWith("forget ") || text.startsWith("please forget ")) {
    // This will be fully implemented in M3
    return false;
  }

  return false;
}

/**
 * Store the user's message in the background.
 */
async function storeUserMessage(context: MessageContext): Promise<void> {
  try {
    await storeMessage({
      slackTs: context.messageTs,
      slackThreadTs: context.threadTs,
      channelId: context.channelId,
      channelType: context.channelType,
      userId: context.userId,
      role: "user",
      content: context.text,
    });
  } catch (error) {
    logger.error("Failed to store user message", { error: String(error) });
  }
}

/**
 * Run background tasks after responding.
 */
async function runBackgroundTasks(params: {
  context: MessageContext;
  response: string;
  displayName: string;
}): Promise<void> {
  const { context, response, displayName } = params;

  try {
    // Store the user's message
    const userMessageId = await storeMessage({
      slackTs: context.messageTs,
      slackThreadTs: context.threadTs,
      channelId: context.channelId,
      channelType: context.channelType,
      userId: context.userId,
      role: "user",
      content: context.text,
    });

    // Store Aura's response
    // Generate a pseudo-timestamp for the assistant message
    const assistantTs = `${context.messageTs}-aura`;
    await storeMessage({
      slackTs: assistantTs,
      slackThreadTs: context.threadTs || context.messageTs,
      channelId: context.channelId,
      channelType: context.channelType,
      userId: "aura",
      role: "assistant",
      content: response,
    });

    // Extract memories from this exchange
    await extractMemories({
      userMessage: context.text,
      assistantResponse: response,
      userId: context.userId,
      channelType: context.channelType,
      sourceMessageId: userMessageId || undefined,
      displayName,
    });

    // Record interaction and potentially update profile
    await recordInteraction(context.userId);
    await updateProfileFromConversation(
      context.userId,
      context.text,
      response,
    );
  } catch (error) {
    logger.error("Background task failed", { error: String(error) });
    // Non-fatal — don't crash
  }
}

/**
 * Resolve a Slack user's display name.
 */
async function resolveDisplayName(
  client: WebClient,
  userId: string,
): Promise<string> {
  try {
    const result = await client.users.info({ user: userId });
    return (
      result.user?.profile?.display_name ||
      result.user?.real_name ||
      result.user?.name ||
      userId
    );
  } catch {
    return userId;
  }
}
