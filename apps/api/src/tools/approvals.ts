import { z } from "zod";
import { defineTool, executionContext } from "../lib/tool.js";
import { createProposal } from "../lib/batch-executor.js";
import { db } from "../db/client.js";
import { approvalPolicies } from "@aura/db/schema";
import { eq } from "drizzle-orm";
import { isAdmin } from "../lib/permissions.js";

// ── Export function for tool registration ────────────────────────────────────

export function createApprovalTools() {
  return {
    propose_batch: proposeBatch,
    manage_approval_policy: manageApprovalPolicy,
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
    credential_name: z.string().optional().describe("API credential to use for all requests in the batch"),
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
      credentialName: input.credential_name,
      items: input.items as any,
      requestedBy: ctx.triggeredBy,
      requestedInChannel: ctx.channelId,
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

// ── manage_approval_policy ───────────────────────────────────────────────────

export const manageApprovalPolicy = defineTool({
  description: `Manage approval policies (admin-only).

Approval policies control which API requests require human approval:
- auto_approve: Execute immediately without approval
- require_approval: Wait for human approval before executing
- deny: Block the request entirely

Policies are evaluated by priority (highest first). The first matching policy wins.

Only workspace admins can create, update, or delete approval policies.`,

  inputSchema: z.object({
    action: z.enum(["create", "update", "delete", "list"]).describe("Action to perform"),
    policy_id: z.string().optional().describe("Policy ID (required for update/delete)"),
    name: z.string().optional().describe("Human-readable policy name"),
    priority: z.number().optional().describe("Priority (higher = evaluated first). Default: 0"),
    tool_pattern: z.string().optional().describe("Tool name pattern (e.g. 'http_request')"),
    url_pattern: z.string().optional().describe("URL glob pattern (e.g. 'https://api.example.com/leads/*')"),
    http_methods: z.array(z.string()).optional().describe("HTTP methods (e.g. ['POST', 'PUT', 'DELETE'])"),
    credential_name: z.string().optional().describe("Credential name to match"),
    policy_action: z.enum(["require_approval", "auto_approve", "deny"]).optional().describe("Policy action"),
    approval_mode: z.enum(["any_one", "all_must"]).optional().describe("Approval mode (any_one = any approver can approve, all_must = all approvers must approve)"),
    approver_ids: z.array(z.string()).optional().describe("List of Slack user IDs who can approve"),
    approval_channel: z.string().optional().describe("Slack channel ID where approval requests are posted"),
  }),

  execute: async (input) => {
    const ctx = executionContext.getStore();
    if (!ctx) {
      return {
        ok: false,
        error: "No execution context available",
      };
    }

    // Check admin permission
    if (!isAdmin(ctx.triggeredBy)) {
      return {
        ok: false,
        error: "Only workspace admins can manage approval policies",
      };
    }

    switch (input.action) {
      case "list": {
        const policies = await db
          .select()
          .from(approvalPolicies)
          .orderBy(approvalPolicies.priority);

        return {
          ok: true,
          policies: policies.map(p => ({
            id: p.id,
            name: p.name,
            priority: p.priority,
            action: p.action,
            approval_mode: p.approvalMode,
            tool_pattern: p.toolPattern,
            url_pattern: p.urlPattern,
            http_methods: p.httpMethods,
            credential_name: p.credentialName,
            approver_ids: p.approverIds,
            approval_channel: p.approvalChannel,
          })),
        };
      }

      case "create": {
        if (!input.name || !input.policy_action) {
          return {
            ok: false,
            error: "name and policy_action are required for creating a policy",
          };
        }

        const [policy] = await db
          .insert(approvalPolicies)
          .values({
            name: input.name,
            priority: input.priority ?? 0,
            toolPattern: input.tool_pattern ?? null,
            urlPattern: input.url_pattern ?? null,
            httpMethods: input.http_methods ?? null,
            credentialName: input.credential_name ?? null,
            action: input.policy_action,
            approvalMode: input.approval_mode ?? "any_one",
            approverIds: input.approver_ids ?? null,
            approvalChannel: input.approval_channel ?? null,
            createdBy: ctx.triggeredBy,
          })
          .returning({ id: approvalPolicies.id });

        return {
          ok: true,
          policy_id: policy.id,
          message: `Policy "${input.name}" created successfully`,
        };
      }

      case "update": {
        if (!input.policy_id) {
          return {
            ok: false,
            error: "policy_id is required for updating a policy",
          };
        }

        const updates: Record<string, any> = {};
        if (input.name !== undefined) updates.name = input.name;
        if (input.priority !== undefined) updates.priority = input.priority;
        if (input.tool_pattern !== undefined) updates.toolPattern = input.tool_pattern;
        if (input.url_pattern !== undefined) updates.urlPattern = input.url_pattern;
        if (input.http_methods !== undefined) updates.httpMethods = input.http_methods;
        if (input.credential_name !== undefined) updates.credentialName = input.credential_name;
        if (input.policy_action !== undefined) updates.action = input.policy_action;
        if (input.approval_mode !== undefined) updates.approvalMode = input.approval_mode;
        if (input.approver_ids !== undefined) updates.approverIds = input.approver_ids;
        if (input.approval_channel !== undefined) updates.approvalChannel = input.approval_channel;
        updates.updatedAt = new Date();

        if (Object.keys(updates).length === 0) {
          return {
            ok: false,
            error: "No fields to update",
          };
        }

        await db
          .update(approvalPolicies)
          .set(updates)
          .where(eq(approvalPolicies.id, input.policy_id));

        return {
          ok: true,
          message: `Policy ${input.policy_id} updated successfully`,
        };
      }

      case "delete": {
        if (!input.policy_id) {
          return {
            ok: false,
            error: "policy_id is required for deleting a policy",
          };
        }

        await db
          .delete(approvalPolicies)
          .where(eq(approvalPolicies.id, input.policy_id));

        return {
          ok: true,
          message: `Policy ${input.policy_id} deleted successfully`,
        };
      }

      default:
        return {
          ok: false,
          error: `Unknown action: ${input.action}`,
        };
    }
  },

  slack: {
    status: (input) => `Managing approval policy: ${input.action}`,
    detail: (input) => input.name ?? input.policy_id ?? "policy",
    output: (result) => result.ok ? (result.message ?? "Success") : result.error,
  },
});
