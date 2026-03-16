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
    .describe("Short action-oriented title (max 120 chars). Include the key entity name/identifier and service name."),
  description: z
    .string()
    .describe("Bullet-point summary using Slack mrkdwn: *bold* for labels, • for bullets. List every meaningful field with its actual value. Do NOT include example/placeholder data."),
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

  const system = `You summarize API requests for a Slack approval card. The reviewer is a busy technical founder who needs to approve or reject in seconds.

Your job: make it instantly clear *what* will happen, *to what*, and *with what data*. The reviewer should never need to inspect raw JSON.

Rules:
- Only use data from the actual request. NEVER invent values or reuse data from the formatting examples.
- Infer the action from HTTP method + URL path (e.g. POST to /leads = create a lead, PATCH to /users/123 = update user 123, DELETE to /contacts/456 = delete contact 456).
- Extract entity names/IDs from the URL path when relevant (e.g. /lead/lead_abc → lead "lead_abc").
- Translate technical/internal field names to plain English (e.g. "custom.cf_xyz" → describe the value, "contacts[0].emails" → "Contact email", "useLegacySql" → omit if not meaningful to a reviewer).
- Use Slack mrkdwn: *bold* for field labels, • for bullet points. NOT Markdown (**bold** is wrong).
- For creates (POST): name the entity + list every field being set with actual values.
- For updates (PUT/PATCH): say what's changing with actual values.
- For deletes (DELETE): say exactly what's being removed, include its identifier.
- For reads (GET): describe what's being fetched and any filters/parameters.
- For queries (SQL, BigQuery, search): summarize what's being queried/searched and why.
- For batch operations: state the count and describe what's being done to each item.
- Format numbers with commas (50000 → 50,000). Format dates to human-readable.
- Skip boilerplate/internal fields that add no reviewer value (API versions, legacy flags, pagination tokens).
- Never repeat the title in the description.
- Be specific with real values — never write generic filler like "various fields will be set".

<examples>
These demonstrate the desired FORMAT only. Never use any data from these in your output.

Input: POST to Close CRM (FR) — /api/v1/lead/
Body: {"name":"Acme Corp","contacts":[{"name":"Jane Doe","emails":[{"email":"jane@acme.com"}]}],"custom.cf_industry":"SaaS"}
→ title: Create lead "Acme Corp" in Close CRM (FR)
→ description:
• *Lead name:* Acme Corp
• *Contact:* Jane Doe (jane@acme.com)
• *Industry:* SaaS

Input: PATCH to unknown API — /api/v1/user/usr_8fK2x
Body: {"role":"admin","department":"Engineering"}
→ title: Update user usr_8fK2x role and department
→ description:
• *Role:* admin
• *Department:* Engineering

Input: DELETE to Close CRM (US) — /api/v1/contact/cont_abc123
→ title: Delete contact cont_abc123 in Close CRM (US)
→ description:
• *Contact ID:* cont_abc123

Input: POST to BigQuery — /bigquery/v2/projects/my-project/queries
Reason: Checking lead counts by status
Body: {"query":"SELECT status, COUNT(*) FROM dataset.leads GROUP BY status"}
→ title: BigQuery: lead counts by status
→ description:
• *Query:* Count leads grouped by status from dataset.leads
• *Reason:* Checking lead counts by status

Input: POST to Exa Search — /search
Body: {"query":"realadvisor competitors switzerland","numResults":10,"type":"auto"}
→ title: Exa search: "realadvisor competitors switzerland"
→ description:
• *Query:* realadvisor competitors switzerland
• *Results requested:* 10
</examples>`;

  const parts = [
    `Service: ${serviceName}`,
    `Method: ${methodUpper}`,
    `URL: ${url}`,
  ];
  if (reason) parts.push(`Reason: ${reason}`);
  if (bodyPreview) parts.push(`Body:\n\`\`\`\n${bodyPreview}\n\`\`\``);
  if (itemCount > 1) parts.push(`Batch size: ${itemCount} items`);
  if (riskNote) parts.push(riskNote);

  const prompt = `Summarize this API request:\n\n${parts.join("\n")}`;

  try {
    const { object } = await generateObject({
      model: fastModel,
      schema: summarySchema,
      system,
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
