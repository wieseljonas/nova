import { z } from "zod";
import { eq } from "drizzle-orm";
import { WebClient } from "@slack/web-api";
import { defineTool, executionContext } from "../lib/tool.js";
import { db } from "../db/client.js";
import { batchProposals, batchItems } from "../db/schema.js";
import { logger } from "../lib/logger.js";

const botToken = process.env.SLACK_BOT_TOKEN || "";

export function createBatchTools() {
  return {
    propose_batch: defineTool({
      description:
        "Propose a batch of HTTP requests for human approval before execution. " +
        "Use this when you need to make multiple similar API calls (e.g. updating 50 leads, deleting 20 records). " +
        "The batch will be presented to the user for review with a summary card showing what will happen. " +
        "After approval, the system executes all items sequentially with rate limiting and progress tracking. " +
        "All items in a batch MUST use the same credential (if required). " +
        "Example use cases: bulk updates, mass deletions, batch imports, multi-step workflows. " +
        "For single requests or < 5 items, use http_request directly instead.",
      inputSchema: z.object({
        action_type: z
          .string()
          .describe("Short label for this batch (e.g. 'bulk_update_leads', 'delete_test_data')"),
        summary_title: z
          .string()
          .describe("Human-readable title for the approval card (e.g. 'Update 47 leads to Qualified status')"),
        summary_details: z
          .string()
          .optional()
          .describe("Optional detailed explanation of what this batch does and why"),
        credential_name: z
          .string()
          .optional()
          .describe("Name of the stored credential to use for ALL requests in this batch"),
        credential_owner: z
          .string()
          .optional()
          .describe("Slack user ID of the credential owner"),
        items: z
          .array(
            z.object({
              method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
              url: z.string().url(),
              body: z.unknown().optional(),
              headers: z.record(z.string()).optional(),
            }),
          )
          .min(1)
          .max(500)
          .describe("Array of HTTP requests to execute (1-500 items)"),
        rate_limit_ms: z
          .number()
          .default(100)
          .describe("Delay in milliseconds between requests (default 100ms = 10 req/s)"),
      }),
      execute: async (input) => {
        const ctx = executionContext.getStore() ?? {
          triggeredBy: "unknown",
          triggerType: "autonomous" as const,
        };

        const credentialOwner = input.credential_owner ?? ctx.triggeredBy;

        if (input.credential_name && !credentialOwner) {
          return {
            ok: false as const,
            error: "credential_owner is required when credential_name is provided",
          };
        }

        // Create batch proposal
        const [batch] = await db
          .insert(batchProposals)
          .values({
            actionType: input.action_type,
            status: "pending_review",
            createdBy: ctx.triggeredBy,
            progressTotal: input.items.length,
            summaryTitle: input.summary_title,
            summaryDetails: input.summary_details ?? null,
            credentialName: input.credential_name ?? null,
            credentialOwner: credentialOwner ?? null,
            context: {
              rateLimitMs: input.rate_limit_ms,
              channelId: ctx.channelId,
              threadTs: ctx.threadTs,
            },
          })
          .returning({ id: batchProposals.id });

        const batchId = batch.id;

        // Create batch items
        await db.insert(batchItems).values(
          input.items.map((item, index) => ({
            batchId,
            index,
            method: item.method,
            url: item.url,
            body: item.body ?? null,
            headers: item.headers ?? null,
            status: "pending" as const,
          })),
        );

        logger.info("Batch proposal created", {
          batchId,
          actionType: input.action_type,
          itemCount: input.items.length,
          createdBy: ctx.triggeredBy,
        });

        // Post Slack approval card
        const slackClient = new WebClient(botToken);
        const channelId = ctx.channelId ?? process.env.AURA_DEFAULT_CHANNEL;

        if (!channelId) {
          return {
            ok: false as const,
            error: "No channel to post approval card to",
          };
        }

        const sampleItems = input.items.slice(0, 3);
        const sampleText = sampleItems
          .map((item, i) => `${i + 1}. \`${item.method} ${item.url}\``)
          .join("\n");
        const moreText = input.items.length > 3 ? `\n...and ${input.items.length - 3} more` : "";

        const blocks: any[] = [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*🔍 Batch Proposal: ${input.summary_title}*`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: input.summary_details || `${input.items.length} HTTP requests ready for execution.`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Sample requests (showing ${Math.min(3, input.items.length)} of ${input.items.length}):*\n${sampleText}${moreText}`,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "✅ Approve & Execute", emoji: true },
                style: "primary",
                action_id: `batch_approve_${batchId}`,
                value: batchId,
              },
              {
                type: "button",
                text: { type: "plain_text", text: "❌ Reject", emoji: true },
                style: "danger",
                action_id: `batch_reject_${batchId}`,
                value: batchId,
              },
              {
                type: "button",
                text: { type: "plain_text", text: "👁 Review All", emoji: true },
                action_id: `batch_review_${batchId}`,
                value: batchId,
              },
            ],
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `\`${input.action_type}\` · ${input.items.length} items · rate limit: ${input.rate_limit_ms}ms${input.credential_name ? ` · credential: ${input.credential_name}` : ""}`,
              },
            ],
          },
        ];

        try {
          const resp = await slackClient.chat.postMessage({
            channel: channelId,
            ...(ctx.threadTs ? { thread_ts: ctx.threadTs } : {}),
            text: `🔍 Batch proposal: ${input.summary_title}`,
            attachments: [
              {
                color: "#e8912d",
                blocks,
              },
            ],
            metadata: {
              event_type: "batch_proposal",
              event_payload: {
                batch_id: batchId,
              },
            },
          });

          const ts = resp.ts ?? "";
          const postedChannel = resp.channel ?? channelId;

          // Store message reference for updates
          await db
            .update(batchProposals)
            .set({
              approvalMessageTs: ts,
              approvalChannelId: postedChannel,
            })
            .where(eq(batchProposals.id, batchId));

          return {
            ok: true as const,
            batchId,
            itemCount: input.items.length,
            message: `Batch proposal created with ${input.items.length} items. Awaiting approval.`,
          };
        } catch (err) {
          logger.error("propose_batch: failed to post Slack message", {
            error: err instanceof Error ? err.message : String(err),
            batchId,
          });
          return {
            ok: false as const,
            error: `Failed to post approval card: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
      slack: {
        status: (input) => `Proposing batch: ${input.summary_title}`,
        detail: (input) => `${input.items.length} items`,
        output: (result: any) =>
          result.ok === false && result.error
            ? result.error
            : `Batch proposal created (${result.itemCount} items)`,
      },
    }),
  };
}
