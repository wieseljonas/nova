import { WebClient } from "@slack/web-api";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { approvals } from "@aura/db/schema";
import { db } from "../db/client.js";
import { getApprovalChannel, getApprovers, getCredentialForApproval, checkAccess } from "../lib/approval.js";
import { defineTool, executionContext } from "../lib/tool.js";
import { logger } from "../lib/logger.js";

const DEFAULT_PROXY_TTL_MINUTES = 15;

export function createApprovalTools() {
  return {
    request_credential_access: requestCredentialAccess,
  };
}

export const requestCredentialAccess = defineTool({
  description: `Request write access to a stored credential for use in sandbox scripts.

Use this when you need to make many authenticated API calls from code running in the sandbox
(bulk updates, imports, sync scripts, large data pulls) and individual http_request calls would
be too slow or too awkward.

After approval, the sandbox will receive NOVA_PROXY_URL and NOVA_PROXY_TOKEN environment variables.
Scripts should call the proxy URL instead of handling raw credentials directly.`,

  inputSchema: z.object({
    credential_key: z.string(),
    credential_owner: z.string().optional(),
    reason: z.string(),
    ttl_minutes: z.number().int().min(5).max(60).optional(),
  }),

  execute: async (input) => {
    const ctx = executionContext.getStore();
    if (!ctx) {
      return {
        ok: false as const,
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
        ok: false as const,
        error: `Credential "${input.credential_key}" not found`,
      };
    }

    const access = checkAccess(credential, ctx.triggeredBy, "POST");
    if (access === "denied") {
      return {
        ok: false as const,
        error: `Access denied: you don't have permission to request sandbox access for credential "${input.credential_key}"`,
      };
    }

    const ttlMinutes = input.ttl_minutes ?? DEFAULT_PROXY_TTL_MINUTES;
    const approverIds = getApprovers(credential);
    const approverMentions =
      approverIds.length > 0
        ? approverIds.map((id) => `<@${id}>`).join(", ")
        : "admins";
    const targetChannel =
      getApprovalChannel(credential) ??
      ctx.channelId ??
      process.env.AURA_DEFAULT_CHANNEL;

    if (!targetChannel) {
      return {
        ok: false as const,
        error: "No approval channel configured",
      };
    }

    const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

    try {
      const [approval] = await db
        .insert(approvals)
        .values({
          title: `Grant sandbox proxy access: ${input.credential_key}`,
          description: input.reason,
          credentialKey: input.credential_key,
          credentialOwner,
          httpMethod: "PROXY_SESSION",
          urlPattern: JSON.stringify({
            kind: "proxy_session",
            ttlMinutes,
          }),
          totalItems: 1,
          requestedBy: ctx.triggeredBy,
          requestedInChannel: ctx.channelId ?? null,
          requestedInThread: ctx.threadTs ?? null,
        })
        .returning({
          id: approvals.id,
        });

      const response = await slackClient.chat.postMessage({
        channel: targetChannel,
        ...(ctx.threadTs && ctx.channelId === targetChannel
          ? { thread_ts: ctx.threadTs }
          : {}),
        text: `Sandbox proxy access requested for ${input.credential_key}`,
        attachments: [
          {
            color: "#e8912d",
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*🔒 Grant sandbox proxy access: \`${input.credential_key}\`*`,
                },
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: input.reason,
                },
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: { type: "plain_text", text: "✅ Approve", emoji: true },
                    style: "primary",
                    action_id: `proxy_approve_${approval.id}`,
                    value: approval.id,
                  },
                  {
                    type: "button",
                    text: { type: "plain_text", text: "❌ Reject", emoji: true },
                    style: "danger",
                    action_id: `proxy_reject_${approval.id}`,
                    value: approval.id,
                  },
                ],
              },
              {
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text:
                      `\`proxy session\` · expires in ${ttlMinutes} minute${ttlMinutes === 1 ? "" : "s"} ` +
                      `· requested by <@${ctx.triggeredBy}> · ${approverMentions}`,
                  },
                ],
              },
            ],
          },
        ],
        metadata: {
          event_type: "proxy_session_request",
          event_payload: {
            approval_id: approval.id,
            credential_key: input.credential_key,
          },
        },
      });

      await db
        .update(approvals)
        .set({
          slackMessageTs: response.ts ?? "",
          slackChannel: response.channel ?? targetChannel,
        })
        .where(eq(approvals.id, approval.id));

      return {
        ok: true as const,
        status: "awaiting_approval" as const,
        approval_id: approval.id,
        message: `Credential access request submitted for ${input.credential_key}. I'll continue once it is approved.`,
      };
    } catch (error) {
      logger.error("request_credential_access failed", {
        credentialKey: input.credential_key,
        credentialOwner,
        requestedBy: ctx.triggeredBy,
        error,
      });
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : "Failed to create credential access request",
      };
    }
  },

  slack: {
    status: (input) => `Requesting sandbox credential access for ${input.credential_key}`,
    detail: (input) => input.reason,
    output: (result) =>
      result.ok
        ? `Awaiting approval: ${result.approval_id}`
        : result.error,
  },
});

