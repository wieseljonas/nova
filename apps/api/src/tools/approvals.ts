import { z } from "zod";
import { defineTool, executionContext } from "../lib/tool.js";
import { db } from "../db/client.js";
import { approvals } from "@aura/db/schema";
import { eq } from "drizzle-orm";
import { checkAccess, getApprovers, getCredentialForApproval } from "../lib/approval.js";
import { logger } from "../lib/logger.js";
import { WebClient } from "@slack/web-api";

// ── Export function for tool registration ────────────────────────────────────

export function createApprovalTools() {
  return {
    request_credential_access: requestCredentialAccess,
  };
}

// ── request_credential_access ────────────────────────────────────────────────

export const requestCredentialAccess = defineTool({
  description: `Request a proxy session to use a credential in sandbox scripts.
Use this when you need to make many API calls (bulk updates, imports, exports)
that would be impractical as individual http_request calls.
For a few one-off requests, use http_request instead (it handles governance per-request).
After approval, NOVA_PROXY_URL and NOVA_PROXY_TOKEN are injected into the sandbox.
Your script calls: curl -H "X-Target-URL: https://api.example.com/endpoint" -H "Authorization: Bearer $NOVA_PROXY_TOKEN" "$NOVA_PROXY_URL/{credential_key}"
The proxy injects the real credential server-side -- scripts never see the secret.`,
  inputSchema: z.object({
    credential_key: z
      .string()
      .describe("Credential key to grant in the proxy session"),
    credential_owner: z
      .string()
      .optional()
      .describe("Slack user ID of the credential owner (defaults to the caller)"),
    reason: z
      .string()
      .describe("Why sandbox proxy access is needed"),
    ttl_minutes: z
      .number()
      .int()
      .min(5)
      .max(60)
      .optional()
      .describe("Token TTL in minutes (default 15, max 60)"),
  }),
  execute: async (input) => {
    const ctx = executionContext.getStore();
    if (!ctx) {
      return {
        ok: false,
        error: "No execution context available",
      };
    }

    const credentialOwner = input.credential_owner ?? ctx.triggeredBy;

    const credential = await getCredentialForApproval(
      input.credential_key,
      credentialOwner,
    );
    if (!credential) {
      return {
        ok: false,
        error: `Credential "${input.credential_key}" not found`,
      };
    }

    const accessDecision = checkAccess(credential, ctx.triggeredBy, "POST");
    if (accessDecision === "denied") {
      return {
        ok: false,
        error: `Access denied for credential "${input.credential_key}"`,
      };
    }

    const ttlMinutes = input.ttl_minutes ?? 15;
    const approvalMetadata = JSON.stringify({
      type: "proxy_session",
      reason: input.reason,
      ttlMinutes,
      credentialKey: input.credential_key,
    });
    const approvalTitle = `Proxy session access: ${input.credential_key}`;

    const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN || "");
    const approvers = getApprovers(credential);
    const approverMentions = approvers.map((id) => `<@${id}>`).join(", ");
    const targetChannel =
      credential.approvalSlackChannelId ??
      ctx.channelId ??
      process.env.AURA_DEFAULT_CHANNEL;

    if (!targetChannel) {
      return {
        ok: false,
        error: "No approval channel configured for this credential",
      };
    }

    const [approval] = await db
      .insert(approvals)
      .values({
        title: approvalTitle,
        description: approvalMetadata,
        credentialKey: input.credential_key,
        credentialOwner,
        urlPattern: "proxy_session",
        httpMethod: "PROXY",
        totalItems: 1,
        requestedBy: ctx.triggeredBy,
        requestedInChannel: ctx.channelId ?? null,
        requestedInThread: ctx.threadTs ?? null,
      })
      .returning({ id: approvals.id });

    const approvalId = approval.id;

    const post = await slackClient.chat.postMessage({
      channel: targetChannel,
      ...(ctx.threadTs ? { thread_ts: ctx.threadTs } : {}),
      text: "",
      attachments: [
        {
          color: "#e8912d",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*🔐 ${approvalTitle}*`,
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `${input.reason}\n• Credential: \`${input.credential_key}\`\n• TTL: ${ttlMinutes} minutes`,
              },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "✅ Approve", emoji: true },
                  style: "primary",
                  action_id: `approval_approve_${approvalId}`,
                  value: approvalId,
                },
                {
                  type: "button",
                  text: { type: "plain_text", text: "❌ Reject", emoji: true },
                  style: "danger",
                  action_id: `approval_reject_${approvalId}`,
                  value: approvalId,
                },
              ],
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `requested by <@${ctx.triggeredBy}> · approvers: ${approverMentions || "admins"}`,
                },
              ],
            },
          ],
        },
      ],
      metadata: {
        event_type: "proxy_session_request",
        event_payload: { approval_id: approvalId },
      },
    });

    await db
      .update(approvals)
      .set({
        slackMessageTs: post.ts ?? "",
        slackChannel: post.channel ?? targetChannel,
      })
      .where(eq(approvals.id, approvalId));

    logger.info("Proxy session approval requested", {
      approvalId,
      credentialKey: input.credential_key,
      requestedBy: ctx.triggeredBy,
      targetChannel,
      ttlMinutes,
    });

    return {
      ok: true,
      status: "awaiting_approval",
      approval_id: approvalId,
      message: "Credential access request submitted for approval.",
    };
  },
  slack: {
    status: "Requesting credential access approval...",
    detail: (input) => `${input.credential_key} · ${input.ttl_minutes ?? 15}m`,
    output: (result: any) =>
      result?.ok ? `Approval requested: ${result.approval_id}` : result?.error,
  },
});
