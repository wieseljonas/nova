/**
 * Generate human-readable proposal summaries for approval cards.
 * Uses the fast LLM model (Haiku) with structured output (generateObject + Zod)
 * to produce compelling, context-rich summaries from the full request details.
 */

import { generateObject } from "ai";
import { z } from "zod";
import { fastModel } from "./ai.js";

interface ProposalSummaryInput {
  credentialName?: string;
  method: string;
  url: string;
  body?: unknown;
  itemCount?: number;
  /** Optional caller-provided context explaining why this request is being made */
  reason?: string;
}

interface ProposalSummary {
  title: string;
  description: string;
}

// ── Credential → human-readable service name ────────────────────────────────

const CREDENTIAL_LABELS: Record<string, string> = {
  close_fr: "Close CRM (FR)",
  close_us: "Close CRM (US)",
  exa_websearch: "Exa Search",
  e2b: "E2B Sandbox",
};

function getServiceName(credentialName?: string): string {
  if (!credentialName) return "unknown API";
  return CREDENTIAL_LABELS[credentialName] ?? credentialName;
}

// ── Structured output schema ────────────────────────────────────────────────

const summarySchema = z.object({
  title: z
    .string()
    .describe("Short action-oriented title (max 80 chars). Include the key entity name/identifier."),
  description: z
    .string()
    .describe("Detailed summary of ALL inputs. Use Slack mrkdwn formatting: *bold* for field names, bullet points with •. List every meaningful field being set with its actual value."),
});

// ── Public API ───────────────────────────────────────────────────────────────

export async function generateProposalSummary(input: ProposalSummaryInput): Promise<ProposalSummary> {
  const { credentialName, method, url, body: rawBody, itemCount = 1, reason } = input;
  const methodUpper = method.toUpperCase();
  const serviceName = getServiceName(credentialName);

  // Parse string bodies — callers sometimes pass JSON as a string
  let body: unknown = rawBody;
  if (typeof rawBody === "string") {
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }
  }

  const bodyStr = body ? (typeof body === "string" ? body : JSON.stringify(body, null, 2)) : null;
  const bodyPreview = bodyStr && bodyStr.length > 3000 ? bodyStr.slice(0, 3000) + "\n...(truncated)" : bodyStr;

  // Determine risk level for framing
  const isDestructive = methodUpper === "DELETE";
  const isBulk = itemCount > 1;
  const riskNote = isDestructive
    ? "⚠️ This is a DELETE request — flag it as destructive and potentially irreversible."
    : isBulk
      ? `⚠️ This is a batch operation affecting ${itemCount} items — emphasize the scope.`
      : "";

  const prompt = `You summarize API requests for a Slack approval card. The reviewer is a busy technical founder who needs to approve or reject in seconds.

Your job: make it instantly clear *what* will happen, *to what*, and *with what data*. The reviewer should never need to click "Review items" or inspect raw JSON.

Rules:
- Translate API/technical field names to plain English (e.g. "custom.cf_xyz" → describe the value, "contacts[0].emails" → "Contact email")
- Use Slack mrkdwn: *bold* for field labels, • for bullet points. NOT Markdown (**bold** is wrong).
- For creates: name the entity being created + list every field being set with actual values
- For updates/patches: say what's changing with actual values
- For deletes: say exactly what's being removed
- Never repeat the title in the description
- Be specific with real values from the body — no generic "various fields will be set"
${riskNote}

Service: ${serviceName}
Method: ${methodUpper}
URL: ${url}
${reason ? `Reason: ${reason}` : ""}
${bodyPreview ? `Body:\n\`\`\`\n${bodyPreview}\n\`\`\`` : "No body"}
${itemCount > 1 ? `Batch size: ${itemCount} items` : ""}

Example input:
POST https://api.close.com/api/v1/lead/
Body: {"name":"Acme Corp","description":"Enterprise prospect","contacts":[{"name":"Jane Doe","emails":[{"email":"jane@acme.com"}]}],"custom.cf_industry":"SaaS","custom.cf_deal_size":"50000"}

Example output:
title: Create lead "Acme Corp" in Close CRM
description: • *Lead name:* Acme Corp
• *Description:* Enterprise prospect
• *Contact:* Jane Doe (jane@acme.com)
• *Industry:* SaaS
• *Deal size:* 50,000

Now summarize the request above.`;

  try {
    const { object } = await generateObject({
      model: fastModel,
      schema: summarySchema,
      prompt,
      temperature: 0,
    });

    return {
      title: object.title.slice(0, 120),
      description: object.description,
    };
  } catch (err) {
    console.warn("generateProposalSummary: LLM call failed, using fallback", err);
  }

  // Fallback: static summary
  return staticFallback(methodUpper, url, body, serviceName, itemCount);
}

// ── Fallback (no LLM) ───────────────────────────────────────────────────────

function staticFallback(
  method: string,
  url: string,
  body: unknown,
  serviceName: string,
  itemCount: number = 1,
): ProposalSummary {
  let urlPath: string;
  try {
    urlPath = new URL(url).pathname;
  } catch {
    urlPath = url.split("?")[0] || url || "/unknown";
  }
  const shortUrl = urlPath.length > 60 ? urlPath.slice(0, 57) + "..." : urlPath;

  return {
    title: itemCount > 1
      ? `${method} ${itemCount} requests to ${shortUrl} via ${serviceName}`
      : `${method} ${shortUrl} via ${serviceName}`,
    description: formatBodyPreview(body),
  };
}

function formatBodyPreview(body: unknown): string {
  if (!body) return "No request body";
  const json = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  if (json.length <= 300) return `\`\`\`\n${json}\n\`\`\``;
  return `\`\`\`\n${json.slice(0, 300)}\n...\n\`\`\``;
}
