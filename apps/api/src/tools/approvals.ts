import { z } from "zod";
import { defineTool, executionContext } from "../lib/tool.js";
import { createProposal } from "../lib/batch-executor.js";

// ── Export function for tool registration ────────────────────────────────────

export function createApprovalTools() {
  return {
    propose_batch: proposeBatch,
  };
}

// ── propose_batch ────────────────────────────────────────────────────────────

export const proposeBatch = defineTool({
  description: `Submit a batch of HTTP requests for approval and execution.

Use this tool when you need to make multiple similar API calls (e.g. updating 50 records, deleting 100 items).
Instead of making individual http_request calls (which would each require approval), batch them together.

The batch will be presented as a single approval card to the user, and all items will execute sequentially after approval.

Example use cases:
- Bulk updating lead statuses in a CRM
- Batch deleting old records
- Mass-updating product prices
- Importing a list of contacts

Returns a proposal_id that tracks the batch through approval and execution.`,

  inputSchema: z.object({
    title: z.string().describe("Short title for the batch operation (e.g. 'Update 50 leads to Qualified')"),
    description: z.string().optional().describe("Optional detailed description of what this batch will do"),
    credential_key: z.string().optional().describe("API credential key to use for all requests in the batch"),
    credential_owner: z.string().optional().describe("Slack user ID of the credential owner"),
    items: z.array(
      z.object({
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).describe("HTTP method"),
        url: z.string().describe("Full URL for this request"),
        body: z.unknown().optional().describe("Request body (for POST/PUT/PATCH)"),
        headers: z.record(z.string()).optional().describe("Additional headers for this request"),
      })
    ).min(1).describe("Array of HTTP requests to execute in this batch"),
  }),

  execute: async (input) => {
    const ctx = executionContext.getStore();
    if (!ctx) {
      return {
        ok: false,
        error: "No execution context available",
      };
    }

    const result = await createProposal({
      title: input.title,
      description: input.description,
      credentialKey: input.credential_key,
      credentialOwner: input.credential_key ? (input.credential_owner ?? ctx.triggeredBy) : undefined,
      items: input.items as any,
      requestedBy: ctx.triggeredBy,
      requestedInChannel: ctx.channelId,
      requestedInThread: ctx.threadTs,
    });

    if (result.ok) {
      return {
        ok: true,
        proposal_id: result.approvalId,
        message: `Batch proposal created with ${input.items.length} items. It has been submitted for approval.`,
      };
    } else {
      return {
        ok: false,
        error: result.error ?? "Failed to create batch proposal",
      };
    }
  },

  slack: {
    status: (input) => `Creating batch proposal: ${input.title}`,
    detail: (input) => `${input.items.length} operations`,
    output: (result) => result.ok ? `Proposal created: ${result.proposal_id}` : result.error,
  },
});

