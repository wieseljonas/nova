import { Hono } from "hono";
import { WebClient } from "@slack/web-api";
import { waitUntil } from "@vercel/functions";
import { cronApp } from "./cron/consolidate.js";
import { heartbeatApp } from "./cron/heartbeat.js";
import { elevenlabsWebhookApp } from "./webhook/elevenlabs.js";
import { executeNowApp } from "./routes/execute-now.js";
import { runPipeline } from "./pipeline/index.js";
import {
  publishHomeTab,
  ACTION_TO_SETTING,
  CREDENTIAL_ACTIONS,
  isAdmin,
  openCredentialModal,
  openAddCredentialModal,
  buildAddCredentialBlocks,
  buildUpdateCredentialBlocks,
  openUpdateCredentialModal,
  openShareCredentialModal,
  openCredentialAccessModal,
} from "./slack/home.js";
import {
  storeApiCredential,
  deleteApiCredential,
  addCredentialReader,
  addCredentialWriter,
  listApiCredentials,
  hasPermission,
} from "./lib/api-credentials.js";
import { resolveConfirmation } from "./lib/confirmation.js";
import { executionContext } from "./lib/tool.js";
import { setSetting } from "./lib/settings.js";
import { logger } from "./lib/logger.js";
import { recordError } from "./lib/metrics.js";
import { safePostMessage } from "./lib/slack-messaging.js";
import { isAuthorizedApprover } from "./lib/approval.js";
import { mintProxyToken } from "./lib/proxy-token.js";
import { proxyApp } from "./routes/proxy.js";
import { injectCredentialAuth } from "./lib/credential-auth.js";
import { isPrivateUrl } from "./lib/ssrf.js";
import { getApiCredentialWithType, auditCredentialHttpUse } from "./lib/api-credentials.js";
import crypto from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import { db } from "./db/client.js";
import { approvals, notes, feedback } from "@aura/db/schema";

// ── Config ──────────────────────────────────────────────────────────────────

const signingSecret = process.env.SLACK_SIGNING_SECRET || "";
const botToken = process.env.SLACK_BOT_TOKEN || "";
const botUserId = process.env.AURA_BOT_USER_ID || "";

if (!signingSecret || !botToken) {
  logger.warn(
    "SLACK_SIGNING_SECRET or SLACK_BOT_TOKEN not set — Slack handlers will not work",
  );
}

const slackClient = new WebClient(botToken);

// ── Hono App ────────────────────────────────────────────────────────────────

export const app = new Hono();

// Health check
app.get("/", (c) => {
  return c.json({
    name: "Nova",
    version: "0.1.0",
    status: "alive",
  });
});

app.get("/api/health", (c) => {
  return c.json({ ok: true, timestamp: new Date().toISOString() });
});

// Mount credential proxy route
app.route("/proxy", proxyApp);

function parseApprovalMetadata(description: string | null | undefined): Record<string, any> | null {
  if (!description) return null;
  try {
    const parsed = JSON.parse(description);
    if (typeof parsed === "object" && parsed !== null && typeof parsed.type === "string") {
      return parsed;
    }
  } catch { /* not JSON or no type field — legacy approval */ }
  return null;
}

// ── Dashboard API (authenticated with DASHBOARD_API_SECRET) ─────────────────

app.get("/api/memories/search", async (c) => {
  const secret = process.env.DASHBOARD_API_SECRET;
  if (!secret) return c.json({ error: "Not configured" }, 503);

  const auth = c.req.header("authorization");
  if (auth !== `Bearer ${secret}`) return c.json({ error: "Unauthorized" }, 401);

  const q = c.req.query("q");
  if (!q) return c.json({ error: "Missing q parameter" }, 400);

  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 50);

  const { retrieveMemories } = await import("./memory/retrieve.js");
  const results = await retrieveMemories({
    query: q,
    currentUserId: "admin",
    limit,
    minRelevanceScore: 0,
    adminMode: true,
  });

  return c.json({
    ok: true,
    memories: results.map((m) => ({
      id: m.id,
      content: m.content,
      type: m.type,
      sourceChannelType: m.sourceChannelType,
      relevanceScore: m.relevanceScore,
      shareable: m.shareable,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      relatedUserIds: m.relatedUserIds,
    })),
  });
});

// Mount cron routes
app.route("/", cronApp);
app.route("/", heartbeatApp);
app.route("/api/execute-now", executeNowApp);

// Mount ElevenLabs voice webhook routes
app.route("/api/webhook/elevenlabs", elevenlabsWebhookApp);

// ── Slack Signature Verification ────────────────────────────────────────────

function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string,
): boolean {
  if (!signingSecret) return false;

  // Reject requests older than 5 minutes (replay attack protection)
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
  if (parseInt(timestamp) < fiveMinutesAgo) return false;

  const sigBasestring = `v0:${timestamp}:${body}`;
  const mySignature =
    "v0=" +
    crypto
      .createHmac("sha256", signingSecret)
      .update(sigBasestring, "utf8")
      .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(mySignature, "utf8"),
      Buffer.from(signature, "utf8"),
    );
  } catch {
    return false;
  }
}

// ── Slack Retry Detection (must be registered before the handler) ───────────

app.use("/api/slack/*", async (c, next) => {
  // Slack retries events if it doesn't get a 200 within 3 seconds.
  // If we see a retry header, acknowledge without re-processing.
  const retryNum = c.req.header("x-slack-retry-num");
  const retryReason = c.req.header("x-slack-retry-reason");

  if (retryNum) {
    logger.info("Slack retry detected — acknowledging without processing", {
      retryNum,
      retryReason,
    });
    return c.json({ ok: true });
  }

  await next();
});

// ── Slack Events Endpoint ───────────────────────────────────────────────────

app.post("/api/slack/events", async (c) => {
  const rawBody = await c.req.text();

  // Parse the body
  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Verify request signature
  const timestamp = c.req.header("x-slack-request-timestamp") || "";
  const signature = c.req.header("x-slack-signature") || "";

  if (!signingSecret) {
    logger.error("SLACK_SIGNING_SECRET is not configured — rejecting request");
    return c.json({ error: "Server misconfigured" }, 500);
  }

  if (!verifySlackSignature(rawBody, timestamp, signature)) {
    logger.warn("Invalid Slack signature — rejecting request");
    return c.json({ error: "Invalid signature" }, 401);
  }

  // Handle Slack URL verification challenge
  if (body.type === "url_verification") {
    logger.info("Slack URL verification challenge received");
    return c.json({ challenge: body.challenge });
  }

  // Process the event
  if (body.event) {
    const event = body.event;

    // Handle reaction events -- store as memory
    if (event.type === "reaction_added" && event.user && event.item) {
      const reactionPromise = (async () => {
        try {
          // ── Store as a lightweight memory via the store module ──
          let userName = event.user;
          try {
            const userResult = await slackClient.users.info({ user: event.user });
            userName =
              userResult.user?.profile?.display_name ||
              userResult.user?.real_name ||
              userResult.user?.name ||
              event.user;
          } catch {}

          const { storeMessage } = await import("./memory/store.js");
          await storeMessage({
            slackTs: `reaction-${event.event_ts}`,
            channelId: event.item.channel || "",
            channelType: "public_channel",
            userId: event.user,
            role: "user",
            content: `${userName} reacted with :${event.reaction}: to a message`,
          });

          logger.info("Reaction event stored", {
            user: userName,
            reaction: event.reaction,
            channel: event.item.channel,
          });
        } catch (err) {
          recordError("reaction_event", err, { userId: event.user });
        }
      })();
      waitUntil(reactionPromise);
      return c.json({ ok: true });
    }

    // Handle assistant thread started — set suggested prompts in split-view
    if (event.type === "assistant_thread_started") {
      const threadStartPromise = (async () => {
        try {
          const channelId = event.assistant_thread?.channel_id;
          const threadTs = event.assistant_thread?.thread_ts;
          if (!channelId || !threadTs) return;

          await slackClient.assistant.threads.setSuggestedPrompts({
            channel_id: channelId,
            thread_ts: threadTs,
            title: "How can I help?",
            prompts: [
              { title: "Catch me up", message: "What happened in my channels while I was away?" },
              { title: "Run a query", message: "Show me this week's key metrics from BigQuery" },
              { title: "Search Slack", message: "Find recent messages about..." },
              { title: "What do you know?", message: "What do you know about me?" },
            ],
          });
        } catch (err) {
          recordError("assistant_thread_started", err);
        }
      })();
      waitUntil(threadStartPromise);
      return c.json({ ok: true });
    }

    // Handle App Home opened
    if (event.type === "app_home_opened") {
      const homePromise = publishHomeTab(slackClient, event.user).catch(
        (err) => {
          recordError("app_home", err, { userId: event.user });
        },
      );
      waitUntil(homePromise);
      return c.json({ ok: true });
    }

    logger.debug("Dispatching Slack event", {
      type: event.type,
      subtype: event.subtype,
      channel: event.channel,
    });

    // Run pipeline asynchronously inside governance execution context.
    // On Vercel, we must acknowledge within 3 seconds, so we process
    // in the background using waitUntil where available.
    const userId = event.user || "unknown";
    const pipelinePromise = executionContext.run(
      {
        triggeredBy: userId,
        triggerType: "user_message",
        channelId: event.channel || undefined,
        threadTs: event.thread_ts || event.ts || undefined,
      },
      () =>
        runPipeline({
          event,
          client: slackClient,
          botUserId,
          teamId: body.team_id,
        }),
    ).catch((err) => {
      recordError("pipeline", err, {
        eventType: event.type,
        channel: event.channel,
      });
    });

    // Keep the function alive after the response is sent so the
    // pipeline can finish (LLM call, Slack reply, memory extraction).
    waitUntil(pipelinePromise);
  }

  // Acknowledge immediately (must happen within 3 seconds for Slack)
  return c.json({ ok: true });
});

// ── Helper Functions ────────────────────────────────────────────────────────

/** Extract credential value from modal state based on auth scheme */
function extractCredentialValue(
  values: Record<string, any> | undefined,
  authScheme: "bearer" | "basic" | "header" | "query" | "oauth_client" | "google_service_account"
): string | undefined {
  if (authScheme === "oauth_client") {
    const clientId = values?.cred_client_id_block?.cred_client_id?.value;
    const clientSecret = values?.cred_client_secret_block?.cred_client_secret?.value;
    const tokenUrl = values?.cred_token_url_block?.cred_token_url?.value;
    if (clientId && clientSecret && tokenUrl) {
      return JSON.stringify({ client_id: clientId, client_secret: clientSecret, token_url: tokenUrl });
    }
  } else if (authScheme === "basic") {
    const username = values?.cred_username_block?.cred_username?.value;
    const password = values?.cred_password_block?.cred_password?.value ?? "";
    if (username) {
      return JSON.stringify({ username, password });
    }
  } else if (authScheme === "header" || authScheme === "query") {
    const key = values?.cred_key_block?.cred_key?.value;
    const secret = values?.cred_secret_block?.cred_secret?.value;
    if (key && secret) {
      return JSON.stringify({ key, secret });
    }
  } else if (authScheme === "google_service_account") {
    const jsonKey = values?.cred_gsa_json_block?.cred_gsa_json?.value;
    const scopes = values?.cred_gsa_scopes_block?.cred_gsa_scopes?.value;
    if (jsonKey) {
      try {
        const parsed = JSON.parse(jsonKey);
        if (scopes) parsed.scopes = scopes;
        return JSON.stringify(parsed);
      } catch {
        return undefined;
      }
    }
  } else {
    return values?.cred_value_block?.cred_value?.value;
  }
  return undefined;
}

async function postEphemeralIfChannel(
  slackClient: WebClient,
  channelId: string | undefined,
  userId: string,
  text: string,
): Promise<void> {
  if (!channelId) return;
  await slackClient.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text,
  });
}

async function loadAuthorizedPendingApproval(args: {
  approvalId: string;
  userId: string;
  channelId?: string;
  slackClient: WebClient;
  unauthorizedText: string;
}): Promise<(typeof approvals.$inferSelect) | null> {
  const { approvalId, userId, channelId, slackClient, unauthorizedText } = args;

  const approvalRows = await db
    .select()
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .limit(1);

  const approval = approvalRows[0];
  if (!approval) {
    logger.error("Approval not found", { approvalId });
    return null;
  }

  if (approval.status !== "pending") {
    logger.warn("Approval is not pending", { approvalId, status: approval.status, userId });
    await postEphemeralIfChannel(
      slackClient,
      channelId,
      userId,
      `This approval has already been ${approval.status}.`,
    );
    return null;
  }

  const credentialAuth = await isAuthorizedApprover(
    approval.credentialKey,
    approval.credentialOwner,
    userId,
  );
  const authorized = isAdmin(userId) || credentialAuth;

  if (!authorized) {
    logger.warn("Unauthorized approval action", {
      approvalId,
      userId,
      credentialKey: approval.credentialKey,
    });
    await postEphemeralIfChannel(slackClient, channelId, userId, unauthorizedText);
    return null;
  }

  return approval;
}

// ── Slack Interactions Endpoint ─────────────────────────────────────────────

app.post("/api/slack/interactions", async (c) => {
  const rawBody = await c.req.text();

  // Verify signature (same as events)
  const timestamp = c.req.header("x-slack-request-timestamp") || "";
  const signature = c.req.header("x-slack-signature") || "";

  if (!verifySlackSignature(rawBody, timestamp, signature)) {
    logger.warn("Invalid Slack signature on interactions endpoint");
    return c.json({ error: "Invalid signature" }, 401);
  }

  // Parse the payload (URL-encoded form with a `payload` field)
  const params = new URLSearchParams(rawBody);
  const payloadStr = params.get("payload");
  if (!payloadStr) {
    return c.json({ error: "Missing payload" }, 400);
  }

  let payload: any;
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    return c.json({ error: "Invalid payload JSON" }, 400);
  }

  // Handle block_actions
  if (payload.type === "block_actions" && payload.actions) {
    const userId = payload.user?.id;

    for (const action of payload.actions) {
      // Feedback buttons — any user can submit
      if (action.action_id === "aura_feedback") {
        const messageTs = payload.message?.ts;
        const channelId = payload.channel?.id;

        logger.info("Response feedback received", {
          userId,
          feedback: action.value,
          messageTs,
          channelId,
        });

        if (messageTs && channelId && userId) {
          const feedbackPromise = (async () => {
            try {
              await db.insert(feedback).values({
                messageTs,
                channelId,
                userId,
                value: action.value,
              }).onConflictDoUpdate({
                target: [feedback.messageTs, feedback.channelId, feedback.userId],
                set: { value: sql`excluded.value` },
              });

              if (action.value === "negative") {
                const threadTs = payload.message?.thread_ts || messageTs;
                const replies = await slackClient.conversations.replies({
                  channel: channelId,
                  ts: threadTs,
                  limit: 50,
                });
                const alreadyAsked = replies.messages?.some(
                  (m) => m.bot_id && m.text?.includes("What could I have done better?"),
                );
                if (!alreadyAsked) {
                  await safePostMessage(slackClient, {
                    channel: channelId,
                    thread_ts: threadTs,
                    text: "What could I have done better?",
                  });
                }
              }
            } catch (err) {
              recordError("feedback.persist", err, { userId, messageTs, channelId });
            }
          })();
          waitUntil(feedbackPromise);
        }
        continue;
      }

      // Admin-only settings changes
      if (!userId || !isAdmin(userId)) {
        logger.warn("Non-admin attempted settings change", { userId });
        continue;
      }

      const settingKey = ACTION_TO_SETTING[action.action_id];
      if (settingKey && action.selected_option?.value) {
        const newValue = action.selected_option.value;

        const savePromise = (async () => {
          try {
            await setSetting(settingKey, newValue, userId);
            await publishHomeTab(slackClient, userId);
          } catch (err) {
            recordError("interactions.save", err, { userId, settingKey });
          }
        })();

        waitUntil(savePromise);
      }

      const credentialKey = CREDENTIAL_ACTIONS[action.action_id];
      if (credentialKey && payload.trigger_id) {
        const modalPromise = openCredentialModal(
          slackClient,
          payload.trigger_id,
          credentialKey,
        ).catch((err) => {
          recordError("interactions.credential_modal", err, {
            userId,
            credentialKey,
          });
        });
        waitUntil(modalPromise);
      }

      // ── User API Credential actions ──────────────────────────────────
      if (action.action_id === "api_credential_add" && payload.trigger_id) {
        if (!isAdmin(userId)) continue;
        const addPromise = openAddCredentialModal(
          slackClient,
          payload.trigger_id,
        ).catch((err) => {
          recordError("interactions.api_credential_add_modal", err, { userId });
        });
        waitUntil(addPromise);
      }

      // Dynamic modal: swap fields when credential auth scheme changes
      if (action.action_id === "cred_auth_scheme" && payload.view) {
        const selectedScheme = (action.selected_option?.value || "bearer") as
          | "bearer"
          | "basic"
          | "header"
          | "query"
          | "oauth_client"
          | "google_service_account";
        // Preserve the name field value if already filled
        const currentName = payload.view.state?.values?.cred_name_block?.cred_name?.value || "";
        const isAdd = payload.view.callback_id === "api_credential_add_submit";
        const blocks = isAdd
          ? buildAddCredentialBlocks(selectedScheme)
          : [
              ...buildUpdateCredentialBlocks(selectedScheme),
              {
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text: "This will replace the current credential value. Encrypted at rest with AES-256-GCM.",
                  },
                ],
              },
            ];

        if (isAdd && currentName) {
          const nameBlock = blocks.find(
            (b: any) => b.block_id === "cred_name_block",
          );
          if (nameBlock) nameBlock.element.initial_value = currentName;
        }

        const titleText =
          payload.view.title?.text ||
          (isAdd ? "Add API Credential" : "Update Credential");
        const updatePromise = slackClient.views.update({
          view_id: payload.view.id,
          hash: payload.view.hash,
          view: {
            type: "modal",
            callback_id: payload.view.callback_id,
            private_metadata: payload.view.private_metadata,
            title: { type: "plain_text", text: titleText },
            submit: { type: "plain_text", text: "Save" },
            close: { type: "plain_text", text: "Cancel" },
            blocks,
          },
        }).catch((err: unknown) => {
          recordError("interactions.cred_auth_scheme_switch", err, {
            userId,
            selectedScheme,
          });
        });
        waitUntil(updatePromise);
      }

      // Overflow menu actions (Update/Share/Delete)
      if (action.action_id?.startsWith("api_credential_overflow_") && action.selected_option?.value) {
        const selectedValue = action.selected_option.value as string;

        if (selectedValue.startsWith("api_credential_update_")) {
          const credId = selectedValue.replace("api_credential_update_", "");
          if (payload.trigger_id) {
            const creds = await listApiCredentials(userId);
            const cred = creds.find((c) => c.id === credId);
            const credKey = cred?.key ?? "credential";
            const credAuthScheme = (cred?.authScheme ??
              "bearer") as "bearer" | "basic" | "header" | "query" | "oauth_client" | "google_service_account";
            const updatePromise = openUpdateCredentialModal(
              slackClient,
              payload.trigger_id,
              credId,
              credKey,
              credAuthScheme,
            ).catch((err) => {
              recordError("interactions.api_credential_update_modal", err, { userId, credId });
            });
            waitUntil(updatePromise);
          }
        } else if (selectedValue.startsWith("api_credential_share_")) {
          const credId = selectedValue.replace("api_credential_share_", "");
          if (payload.trigger_id) {
            const sharePromise = openShareCredentialModal(
              slackClient,
              payload.trigger_id,
              credId,
            ).catch((err) => {
              recordError("interactions.api_credential_share_modal", err, { userId, credId });
            });
            waitUntil(sharePromise);
          }
        } else if (selectedValue.startsWith("api_credential_delete_")) {
          const credId = selectedValue.replace("api_credential_delete_", "");
          const deletePromise = (async () => {
            try {
              await deleteApiCredential(credId, userId);
              await publishHomeTab(slackClient, userId);
            } catch (err) {
              recordError("interactions.api_credential_delete", err, { userId, credId });
            }
          })();
          waitUntil(deletePromise);
        } else if (selectedValue.startsWith("api_credential_access_") && payload.trigger_id) {
          const rest = selectedValue.slice("api_credential_access_".length);
          const lastUnderscore = rest.lastIndexOf("_");
          const credId = lastUnderscore > 0 ? rest.substring(0, lastUnderscore) : rest;
          const accessPromise = openCredentialAccessModal(
            slackClient,
            payload.trigger_id,
            credId,
          ).catch((err) => {
            recordError("interactions.api_credential_access_modal", err, { userId, credId });
          });
          waitUntil(accessPromise);
        }
      }

      // ── Confirmation buttons (Phase 4) ──────────────────────────────
      if (action.action_id?.startsWith("confirm_approve_")) {
        const token = action.action_id.replace("confirm_approve_", "");
        const approvePromise = (async () => {
          try {
            const entry = resolveConfirmation(token, true);
            if (entry && entry.userId === userId) {
              const channelId = payload.channel?.id;
              if (channelId) {
                await slackClient.chat.postMessage({
                  channel: channelId,
                  text: `Approved: ${entry.action}`,
                });
              }
            }
          } catch (err) {
            recordError("interactions.confirm_approve", err, { userId });
          }
        })();
        waitUntil(approvePromise);
      }

      if (action.action_id?.startsWith("confirm_deny_")) {
        const token = action.action_id.replace("confirm_deny_", "");
        const denyPromise = (async () => {
          try {
            const entry = resolveConfirmation(token, false);
            if (entry && entry.userId === userId) {
              const channelId = payload.channel?.id;
              if (channelId) {
                await slackClient.chat.postMessage({
                  channel: channelId,
                  text: `Denied: ${entry.action}`,
                });
              }
            } else if (entry && entry.userId !== userId) {
              const channelId = payload.channel?.id;
              if (channelId) {
                await slackClient.chat.postEphemeral({
                  channel: channelId,
                  user: userId,
                  text: "You can only deny your own confirmation requests.",
                });
              }
            }
          } catch (err) {
            recordError("interactions.confirm_deny", err, { userId });
          }
        })();
        waitUntil(denyPromise);
      }

      // ── Unified approval system buttons ─────────────────────────────────
      if (action.action_id?.startsWith("approval_approve_")) {
        const approvalId = action.action_id.replace("approval_approve_", "");

        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(approvalId)) {
          logger.warn("Invalid approvalId in action_id", { actionId: action.action_id });
          return c.body("ok");
        }

        const approvePromise = (async () => {
          try {
            const channelId = payload.channel?.id;
            const approval = await loadAuthorizedPendingApproval({
              approvalId,
              userId,
              channelId,
              slackClient,
              unauthorizedText: "You're not authorized to approve this.",
            });
            if (!approval) return;

            const updatedRows = await db
              .update(approvals)
              .set({
                status: "approved",
                approvedBy: sql`array_append(${approvals.approvedBy}, ${userId})`,
                updatedAt: new Date(),
              })
              .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
              .returning();

            const approved = updatedRows[0];
            if (!approved) {
              await postEphemeralIfChannel(slackClient, channelId, userId, "This approval has already been processed.");
              return;
            }

            const meta = parseApprovalMetadata(approved.description);
            let resultText: string;
            let cardColor = "#2eb67d";
            let cardIcon = "✅";
            let cardContext = `Approved by <@${userId}>`;

            if (meta?.type === "proxy_session") {
              // ── Proxy session: mint JWT, store token ──
              if (!approved.credentialKey) {
                await postEphemeralIfChannel(slackClient, channelId, userId, "Approval is missing credential metadata.");
                return;
              }
              const ttlMinutes = (typeof meta.ttlMinutes === "number" && meta.ttlMinutes >= 5 && meta.ttlMinutes <= 60) ? meta.ttlMinutes : 15;
              const proxyToken = mintProxyToken({
                credentialKeys: [approved.credentialKey],
                userId: approved.requestedBy,
                credentialOwner: approved.credentialOwner ?? approved.requestedBy,
                ttlMinutes,
              });
              await setSetting(`proxy_session_token:${approved.requestedBy}`, proxyToken, userId);
              cardContext = `Approved by <@${userId}> · token TTL ${ttlMinutes}m`;
              resultText = `Access to ${approved.credentialKey} granted. Use NOVA_PROXY_URL and NOVA_PROXY_TOKEN in your sandbox scripts. Token expires in ${ttlMinutes} minutes.`;

            } else if (meta?.type === "http_request") {
              // ── HTTP request: execute inline ──
              const credKey = meta.credentialKey as string;
              const credOwner = meta.credentialOwner as string;
              const method = meta.method as string;
              const url = meta.url as string;

              const credential = await getApiCredentialWithType(credKey, credOwner, credOwner, "write");
              if (!credential) {
                await db.update(approvals).set({ status: "failed", updatedAt: new Date() }).where(eq(approvals.id, approvalId));
                cardColor = "#e01e5a";
                cardIcon = "❌";
                cardContext = `Failed · approved by <@${userId}>`;
                resultText = `Failed: credential "${credKey}" not found or expired.`;
              } else if (await isPrivateUrl(url)) {
                await db.update(approvals).set({ status: "failed", updatedAt: new Date() }).where(eq(approvals.id, approvalId));
                cardColor = "#e01e5a";
                cardIcon = "❌";
                cardContext = `Blocked · approved by <@${userId}>`;
                resultText = `Blocked: URL resolves to a private/internal address.`;
              } else {
                const injected = injectCredentialAuth(url, (meta.headers as Record<string, string>) ?? {}, {
                  authScheme: credential.authScheme,
                  value: credential.value,
                });
                const headers = injected.headers;
                if (meta.body && method !== "GET" && method !== "HEAD" && !Object.keys(headers).some(k => k.toLowerCase() === "content-type")) {
                  headers["Content-Type"] = "application/json";
                }

                const response = await fetch(injected.url, {
                  method,
                  headers,
                  body: meta.body ? (typeof meta.body === "string" ? meta.body : JSON.stringify(meta.body)) : undefined,
                  redirect: "manual",
                });
                const responseText = await response.text();
                let responseBody: any = responseText;
                try { responseBody = JSON.parse(responseText); } catch { /* keep as text */ }

                auditCredentialHttpUse(
                  credential.id, credKey, credOwner,
                  { method, url, headers: meta.headers, body: meta.body },
                  { status: response.status, body: responseBody },
                ).catch(() => {});

                const finalStatus = response.ok ? "completed" : "failed";
                await db.update(approvals).set({
                  status: finalStatus, completedItems: response.ok ? 1 : 0, failedItems: response.ok ? 0 : 1, updatedAt: new Date(),
                }).where(eq(approvals.id, approvalId));

                cardColor = response.ok ? "#2eb67d" : "#e01e5a";
                cardIcon = response.ok ? "✅" : "❌";
                cardContext = `${cardIcon} HTTP ${response.status} · approved by <@${userId}>`;
                const bodyPreview = JSON.stringify(responseBody).slice(0, 5000);
                resultText = response.ok
                  ? `Request approved and executed. HTTP ${response.status}. Response:\n${bodyPreview}`
                  : `Request approved but failed. HTTP ${response.status}. Response:\n${bodyPreview}`;
              }

            } else {
              resultText = `Approval ${approvalId} approved.`;
            }

            // Update Slack card
            if (approved.slackChannel && approved.slackMessageTs) {
              await slackClient.chat.update({
                channel: approved.slackChannel,
                ts: approved.slackMessageTs,
                text: `Approved by <@${userId}>`,
                attachments: [{
                  color: cardColor,
                  blocks: [
                    { type: "section", text: { type: "mrkdwn", text: `*${cardIcon} ${approved.title}*` } },
                    { type: "context", elements: [{ type: "mrkdwn", text: cardContext }] },
                  ],
                }],
              });
            }

            // Re-invoke pipeline
            if (approved.requestedInChannel && approved.requestedInThread) {
              const syntheticEvent = {
                type: "message" as const,
                channel: approved.requestedInChannel,
                ts: `${(Date.now() / 1000).toFixed(6)}`,
                thread_ts: approved.requestedInThread,
                text: resultText,
                user: approved.requestedBy,
                channel_type: approved.requestedInChannel.startsWith("D") ? "im" : "channel",
              };

              await executionContext.run(
                {
                  triggeredBy: approved.requestedBy,
                  triggerType: "user_message",
                  channelId: approved.requestedInChannel,
                  threadTs: approved.requestedInThread,
                },
                () => runPipeline({ event: syntheticEvent, client: slackClient, botUserId, teamId: payload.team?.id }),
              );
            }

            logger.info("Approval processed", { approvalId, type: meta?.type, approvedBy: userId });
          } catch (err) {
            recordError("interactions.approval_approve", err, { userId, approvalId });
            logger.error("Approval handler failed", { userId, approvalId, error: err });
          }
        })();
        waitUntil(approvePromise);
      }

      if (action.action_id?.startsWith("approval_reject_")) {
        const approvalId = action.action_id.replace("approval_reject_", "");

        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(approvalId)) {
          logger.warn("Invalid approvalId in action_id", { actionId: action.action_id });
          return c.body("ok");
        }

        const rejectPromise = (async () => {
          try {
            const channelId = payload.channel?.id;
            const approval = await loadAuthorizedPendingApproval({
              approvalId,
              userId,
              channelId,
              slackClient,
              unauthorizedText: "You're not authorized to reject this.",
            });
            if (!approval) return;

            const rejectedRows = await db
              .update(approvals)
              .set({ status: "rejected", updatedAt: new Date() })
              .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
              .returning();

            if (rejectedRows.length === 0) {
              await postEphemeralIfChannel(slackClient, channelId, userId, "This approval has already been processed.");
              return;
            }

            if (approval.slackChannel && approval.slackMessageTs) {
              await slackClient.chat.update({
                channel: approval.slackChannel,
                ts: approval.slackMessageTs,
                text: `Rejected by <@${userId}>`,
                attachments: [{
                  color: "#e01e5a",
                  blocks: [
                    { type: "section", text: { type: "mrkdwn", text: `*❌ ${approval.title}*` } },
                    { type: "context", elements: [{ type: "mrkdwn", text: `Rejected by <@${userId}>` }] },
                  ],
                }],
              });
            }

            logger.info("Approval rejected", { approvalId, rejectedBy: userId });
          } catch (err) {
            recordError("interactions.approval_reject", err, { userId, approvalId });
            logger.error("Rejection handler failed", { userId, approvalId, error: err });
          }
        })();
        waitUntil(rejectPromise);
      }

    }
  }

  if (payload.type === "view_submission") {
    const callbackId = payload.view?.callback_id;
    const userId = payload.user?.id;

    if (callbackId === "credential_submit" && userId && isAdmin(userId)) {
      const credentialKey = payload.view?.private_metadata;
      const newValue =
        payload.view?.state?.values?.credential_input_block?.credential_value
          ?.value;

      if (credentialKey && newValue) {
        const savePromise = (async () => {
          try {
            const { setCredential } = await import("./lib/credentials.js");
            await setCredential(credentialKey, newValue, userId);
            await publishHomeTab(slackClient, userId);
          } catch (err) {
            recordError("interactions.credential_save", err, {
              userId,
              credentialKey,
            });
          }
        })();
        waitUntil(savePromise);
      }
    }

    if (callbackId === "api_credential_add_submit" && userId) {
      if (!isAdmin(userId)) return c.json({});
      const name = payload.view?.state?.values?.cred_name_block?.cred_name?.value;
      const description = payload.view?.state?.values?.cred_description_block?.cred_description?.value || null;
      const expiryStr = payload.view?.state?.values?.cred_expiry_block?.cred_expiry?.selected_date;
      const authScheme = (payload.view?.state?.values?.cred_auth_scheme_block?.cred_auth_scheme?.selected_option?.value || "bearer") as
        | "bearer"
        | "basic"
        | "header"
        | "query"
        | "oauth_client"
        | "google_service_account";

      const value = extractCredentialValue(payload.view?.state?.values, authScheme);

      if (name && value) {

        const expiresAt = expiryStr ? new Date(expiryStr) : undefined;
        const addPromise = (async () => {
          try {
            const cred = await storeApiCredential(userId, name, value, expiresAt, authScheme);
            if (description) {
              const { db: db2 } = await import("./db/client.js");
              const { credentials: credTable } = await import("@aura/db/schema");
              const { eq: eq2 } = await import("drizzle-orm");
              await db2.update(credTable).set({ description }).where(eq2(credTable.id, cred.id));
            }
            await publishHomeTab(slackClient, userId);
          } catch (err) {
            recordError("interactions.api_credential_add", err, { userId, name });
            try {
              const errorMsg = err instanceof Error ? err.message : String(err);
              const safeErrorMsg = value ? errorMsg.replaceAll(value, "[REDACTED]") : errorMsg;
              await slackClient.chat.postMessage({
                channel: userId,
                text: `Failed to save credential "${name}": ${safeErrorMsg}`,
              });
            } catch { /* best effort */ }
          }
        })();
        waitUntil(addPromise);
      } else if (name && !value) {
        // Value extraction failed -- return validation error to the modal
        console.warn(`[credential-add] value extraction failed for scheme=${authScheme}, user=${userId}, name=${name}`);
        const errorBlock = authScheme === "basic" ? "cred_username_block"
          : authScheme === "oauth_client" ? "cred_client_id_block"
          : authScheme === "google_service_account" ? "cred_gsa_json_block"
          : authScheme === "header" || authScheme === "query" ? "cred_secret_block"
          : "cred_value_block";
        return c.json({
          response_action: "errors",
          errors: {
            [errorBlock]: "Required field is missing. Please fill in all required fields.",
          },
        });
      }
    }

    if (callbackId === "api_credential_update_submit" && userId) {
      const credentialId = payload.view?.private_metadata;
      const authScheme = (payload.view?.state?.values?.cred_auth_scheme_block?.cred_auth_scheme?.selected_option?.value || "bearer") as
        | "bearer"
        | "basic"
        | "header"
        | "query"
        | "oauth_client"
        | "google_service_account";

      const value = extractCredentialValue(payload.view?.state?.values, authScheme);
      const updateDescription = payload.view?.state?.values?.cred_description_block?.cred_description?.value ?? null;

      if (credentialId && value) {
        const updatePromise = (async () => {
          try {
            const creds = await listApiCredentials(userId);
            const cred = creds.find((c) => c.id === credentialId);
            if (!cred) return;

            const allowed = await hasPermission(cred.owner_user_id, cred.id, userId, "write");
            if (!allowed) {
              await slackClient.chat.postEphemeral({
                channel: userId,
                user: userId,
                text: `Permission denied: you don't have write access to credential "${cred.key}".`,
              });
              return;
            }

            const updatedCred = await storeApiCredential(
              cred.owner_user_id,
              cred.key,
              value,
              cred.expires_at ?? undefined,
              authScheme,
            );
            if (updateDescription !== null) {
              const { db: db3 } = await import("./db/client.js");
              const { credentials: credTable3 } = await import("@aura/db/schema");
              const { eq: eq3 } = await import("drizzle-orm");
              await db3.update(credTable3).set({ description: updateDescription || null }).where(eq3(credTable3.id, updatedCred.id));
            }
            await publishHomeTab(slackClient, userId);
          } catch (err) {
            recordError("interactions.api_credential_update", err, { userId, credentialId });
          }
        })();
        waitUntil(updatePromise);
      }
    }

    if (callbackId === "api_credential_share_submit" && userId) {
      const credentialId = payload.view?.private_metadata;
      const granteeId = payload.view?.state?.values?.share_users_block?.share_user?.selected_user;
      const permission = payload.view?.state?.values?.share_permission_block?.share_permission?.selected_option?.value;

      if (credentialId && granteeId && permission) {
        const sharePromise = (async () => {
          try {
            if (permission === "read") {
              await addCredentialReader(credentialId, userId, granteeId);
            } else if (permission === "write") {
              await addCredentialWriter(credentialId, userId, granteeId);
            }
            await publishHomeTab(slackClient, userId);
          } catch (err) {
            recordError("interactions.api_credential_share", err, { userId, credentialId });
          }
        })();
        waitUntil(sharePromise);
      }
    }


    // Slack modals require empty response or response_action to close properly
    return c.json({ response_action: "clear" });
  }

  // Acknowledge immediately
  return c.json({ ok: true });
});

// ── Google OAuth Routes (Gmail) ─────────────────────────────────────────────

app.get("/api/oauth/google/auth-url", async (c) => {
  const userId = c.req.query("user_id");
  const { generateAuthUrlForUser } = await import("./lib/gmail.js");

  if (userId) {
    const authHeader = c.req.header("authorization") || "";
    const expectedSecret = signingSecret;
    if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  const resolvedUserId = userId || process.env.AURA_BOT_USER_ID || "aura";
  const url = generateAuthUrlForUser(resolvedUserId);
  if (!url) return c.json({ error: "Gmail OAuth not configured" }, 500);

  return c.json({
    url,
    instructions: userId
      ? `Open this URL in a browser logged in as the Gmail account for Slack user ${userId}`
      : "Open this URL in a browser logged in as your Nova email account",
  });
});

app.get("/api/oauth/google/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "No auth code received" }, 400);

  // Parse state to get user_id — always required now
  const stateParam = c.req.query("state");
  let userId: string | undefined;
  if (stateParam) {
    const { verifyOAuthState } = await import("./lib/gmail.js");
    const verified = verifyOAuthState(stateParam);
    if (verified) {
      userId = verified;
    } else {
      return c.json({ error: "Invalid or expired OAuth state" }, 403);
    }
  }

  // Fallback for legacy auth URLs without state
  if (!userId) {
    userId = process.env.AURA_BOT_USER_ID || "aura";
  }

  const { exchangeCodeForTokens, saveUserRefreshToken } = await import("./lib/gmail.js");
  const result = await exchangeCodeForTokens(code);
  if (!result.refreshToken) return c.json({ error: "Token exchange failed", detail: result.error || "No refresh token returned" }, 500);

  // Always save to oauth_tokens table, keyed by (user_id, provider)
  try {
    await saveUserRefreshToken(userId, result.refreshToken, result.email);
    logger.info("OAuth refresh token saved to oauth_tokens", { userId, email: result.email });
    return c.json({
      success: true,
      message: `Gmail connected for ${userId}! Refresh token saved. Active immediately — no redeploy needed.`,
    });
  } catch (saveError: any) {
    logger.error("Failed to save refresh token to oauth_tokens", { userId, error: saveError.message });
    return c.json({
      success: false,
      error: `Failed to save token: ${saveError.message}`,
    }, 500);
  }
});

// ── Cursor Agent Webhook ───────────────────────────────────────────────────

function verifyCursorWebhookSignature(
  rawBody: string,
  signature: string,
): boolean {
  const secret = process.env.CURSOR_WEBHOOK_SECRET;
  if (!secret || !signature) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(signature, "utf8"),
    );
  } catch {
    return false;
  }
}

app.post("/api/webhook/cursor-agent", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-webhook-signature") || "";

  if (!process.env.CURSOR_WEBHOOK_SECRET) {
    logger.warn("CURSOR_WEBHOOK_SECRET not configured — rejecting webhook");
    return c.json({ error: "Webhook not configured" }, 403);
  }

  if (!verifyCursorWebhookSignature(rawBody, signature)) {
    logger.warn("Invalid Cursor webhook signature — rejecting");
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const agentId: string = payload.id || payload.agentId || "";
  const status: string = payload.status || payload.event || "";
  const prUrl: string = payload.target?.prUrl || payload.prUrl || "";
  const branchName: string =
    payload.target?.branchName || payload.branchName || "";
  const summary: string = payload.summary || "";
  const webhookId = c.req.header("x-webhook-id") || "";

  logger.info("Cursor agent webhook received", {
    agentId,
    status,
    webhookId,
    prUrl,
  });

  const processWebhook = async () => {
    try {
      let requester = "";
      let channelId = "";
      let threadTs = "";

      if (agentId) {
        const trackingRows = await db
          .select({ content: notes.content })
          .from(notes)
          .where(eq(notes.topic, `cursor-agent:${agentId}`))
          .limit(1);

        if (trackingRows[0]?.content) {
          const content = trackingRows[0].content;
          const requesterMatch = content.match(
            /\*\*Requester\*\*:\s*(\S+)/,
          );
          const channelMatch = content.match(/\*\*Channel\*\*:\s*(\S+)/);
          const threadMatch = content.match(/\*\*Thread\*\*:\s*(\S+)/);
          if (requesterMatch && requesterMatch[1] !== "unknown")
            requester = requesterMatch[1];
          if (channelMatch) channelId = channelMatch[1];
          if (threadMatch && threadMatch[1] !== "none")
            threadTs = threadMatch[1];
        }
      }

      const adminIds = (process.env.AURA_ADMIN_USER_IDS || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      const dmTarget = requester || adminIds[0];

      if (!dmTarget) {
        logger.warn("Cursor agent webhook: no DM target found", { agentId });
        return;
      }

      const isFinished =
        status.toLowerCase() === "finished" ||
        status.toLowerCase() === "completed";
      const isError =
        status.toLowerCase() === "error" ||
        status.toLowerCase() === "failed";

      let prTitle = "";
      if (prUrl) {
        const prMatch = prUrl.match(/\/pull\/(\d+)$/);
        if (prMatch) {
          try {
            const { getCredential } = await import("./lib/credentials.js");
            const ghToken = await getCredential("github_token");
            if (ghToken) {
              const prNumber = prMatch[1];
              const repoMatch = prUrl.match(
                /github\.com\/([^/]+\/[^/]+)\/pull/,
              );
              if (repoMatch) {
                const ghRes = await fetch(
                  `https://api.github.com/repos/${repoMatch[1]}/pulls/${prNumber}`,
                  {
                    headers: {
                      Authorization: `token ${ghToken}`,
                      Accept: "application/vnd.github.v3+json",
                    },
                  },
                );
                if ((ghRes as any).ok) {
                  const prData = (await (ghRes as any).json()) as any;
                  prTitle = prData.title || "";
                }
              }
            }
          } catch {
            /* fallback to no title */
          }
        }
      }

      let message: string;
      if (isFinished) {
        const safePrTitle = prTitle
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\|/g, "\u2758");
        const prLine = prUrl
          ? safePrTitle
            ? `\u2705 *<${prUrl}|${safePrTitle}>*`
            : `\u2705 *<${prUrl}|PR>*`
          : "\u2705 Agent finished";
        const branchLine = branchName
          ? `\n_Branch:_ \`${branchName}\``
          : "";
        const summaryLine = summary ? `\n\n${summary}` : "";
        message = `${prLine}${branchLine}${summaryLine}`;
      } else if (isError) {
        message = `\u274C Agent *failed*${summary ? `\n\n${summary}` : ""}`;
      } else {
        message = `Agent status: *${status}*`;
      }

      if (isFinished && agentId) {
        try {
          const { getCursorConversation } = await import(
            "./lib/cursor-agent.js"
          );
          const conversation = await getCursorConversation(agentId);
          if (conversation?.summary) {
            message += `\n\n_${conversation.summary}_`;
          }
        } catch {
          /* non-critical */
        }
      }

      const dmResult = await slackClient.conversations.open({
        users: dmTarget,
      });
      const dmChannelId = dmResult.channel?.id;

      if (dmChannelId) {
        const useThreadTs =
          channelId === dmChannelId && threadTs ? threadTs : undefined;
        await safePostMessage(slackClient, {
          channel: dmChannelId,
          thread_ts: useThreadTs,
          text: message,
        });
        logger.info("Cursor agent webhook: DM sent", {
          agentId,
          target: dmTarget,
          status,
        });
      }

      if (
        channelId &&
        channelId !== "unknown" &&
        channelId !== dmChannelId
      ) {
        await safePostMessage(slackClient, {
          channel: channelId,
          thread_ts: threadTs || undefined,
          text: message,
        });
        logger.info("Cursor agent webhook: thread notification sent", {
          agentId,
          channelId,
          threadTs,
          status,
        });
      }
    } catch (err) {
      recordError("cursor_agent_webhook", err, { agentId, status });
    }
  };

  waitUntil(processWebhook());
  return c.json({ ok: true });
});

export default app;
