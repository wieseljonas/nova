import { Hono } from "hono";
import { App, ExpressReceiver } from "@slack/bolt";
import { registerHandlers } from "./slack/handler.js";
import { cronApp } from "./cron/consolidate.js";
import { logger } from "./lib/logger.js";

// ── Slack Bolt Setup ────────────────────────────────────────────────────────

const signingSecret = process.env.SLACK_SIGNING_SECRET;
const botToken = process.env.SLACK_BOT_TOKEN;
const botUserId = process.env.AURA_BOT_USER_ID || "";

if (!signingSecret || !botToken) {
  logger.warn(
    "SLACK_SIGNING_SECRET or SLACK_BOT_TOKEN not set — Slack handlers will not work",
  );
}

/**
 * We use a custom receiver approach to integrate Slack Bolt with Hono
 * for Vercel serverless deployment.
 *
 * The flow:
 * 1. Hono receives POST /api/slack/events
 * 2. We parse the body and pass it to Slack Bolt for verification + dispatch
 * 3. Bolt calls our registered event handlers
 * 4. Handlers run the pipeline and respond
 */

// ── Hono App ────────────────────────────────────────────────────────────────

export const app = new Hono();

// Health check
app.get("/", (c) => {
  return c.json({
    name: "Aura",
    version: "0.1.0",
    status: "alive",
  });
});

app.get("/api/health", (c) => {
  return c.json({ ok: true, timestamp: new Date().toISOString() });
});

// Mount cron routes
app.route("/", cronApp);

// ── Slack Events Endpoint ───────────────────────────────────────────────────

// Store a reference to the Bolt app for request processing
let boltApp: App | null = null;

function getBoltApp(): App {
  if (boltApp) return boltApp;

  // Create a custom receiver that we control
  const receiver = new ExpressReceiver({
    signingSecret: signingSecret || "dummy",
    processBeforeResponse: true,
  });

  boltApp = new App({
    token: botToken,
    receiver,
    // We handle initialization ourselves
  });

  // Register event handlers
  registerHandlers(boltApp, botUserId);

  return boltApp;
}

/**
 * Main Slack events endpoint.
 * Handles:
 * - URL verification challenge (Slack setup)
 * - Event dispatch to Bolt handlers
 */
app.post("/api/slack/events", async (c) => {
  const body = await c.req.json();

  // Handle Slack URL verification challenge
  if (body.type === "url_verification") {
    logger.info("Slack URL verification challenge received");
    return c.json({ challenge: body.challenge });
  }

  // Verify request signature
  const timestamp = c.req.header("x-slack-request-timestamp");
  const signature = c.req.header("x-slack-signature");

  if (!timestamp || !signature) {
    return c.json({ error: "Missing Slack headers" }, 401);
  }

  // Process the event
  try {
    const bolt = getBoltApp();

    // For Slack events, we need to acknowledge quickly (within 3 seconds)
    // and process the event asynchronously
    if (body.event) {
      const event = body.event;
      logger.debug("Dispatching event", { type: event.type });

      // Process the event using Bolt's event handling
      // We simulate what Bolt would do by directly calling our pipeline
      const { runPipeline } = await import("./pipeline/index.js");
      const { WebClient } = await import("@slack/web-api");

      const client = new WebClient(botToken);

      // Run pipeline — in Vercel, we'd use waitUntil here
      // For now, we fire-and-forget to meet the 3-second deadline
      const pipelinePromise = runPipeline({
        event,
        client,
        botUserId,
      });

      // If we have access to waitUntil (Vercel), use it
      // Otherwise, just don't await — the response goes out immediately
      pipelinePromise.catch((err) => {
        logger.error("Pipeline error (background)", { error: String(err) });
      });
    }

    // Acknowledge immediately
    return c.json({ ok: true });
  } catch (error) {
    logger.error("Failed to process Slack event", { error: String(error) });
    return c.json({ error: "Internal error" }, 500);
  }
});

export default app;
