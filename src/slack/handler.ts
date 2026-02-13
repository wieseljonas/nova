import type { App } from "@slack/bolt";
import { runPipeline } from "../pipeline/index.js";
import { logger } from "../lib/logger.js";

/**
 * Register Slack event handlers on the Bolt app.
 *
 * We listen for:
 * - message events (DMs and channels)
 * - app_mention events (when @Aura is used in channels)
 */
export function registerHandlers(
  app: App,
  botUserId: string,
  waitUntil?: (promise: Promise<unknown>) => void,
): void {
  // Handle all message events
  app.event("message", async ({ event, client }) => {
    logger.debug("Received message event", {
      channel: event.channel,
      type: event.type,
    });

    await runPipeline({
      event,
      client,
      botUserId,
      waitUntil,
    });
  });

  // Handle @mentions explicitly
  app.event("app_mention", async ({ event, client }) => {
    logger.debug("Received app_mention event", {
      channel: event.channel,
      user: event.user,
    });

    await runPipeline({
      event,
      client,
      botUserId,
      waitUntil,
    });
  });

  logger.info("Slack event handlers registered");
}
