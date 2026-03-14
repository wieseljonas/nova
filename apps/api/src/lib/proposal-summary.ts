/**
 * Generate human-readable proposal summaries for approval cards.
 * Uses the fast LLM model (Haiku) to produce compelling, context-rich summaries
 * from the full request details (method, URL, body, credential).
 */

import { generateText } from "ai";
import { fastModel } from "./ai.js";

interface ProposalSummaryInput {
  credentialName?: string;
  method: string;
  url: string;
  body?: unknown;
  itemCount?: number;
}

interface ProposalSummary {
  title: string;
  description: string;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function generateProposalSummary(input: ProposalSummaryInput): Promise<ProposalSummary> {
  const { credentialName, method, url, body: rawBody, itemCount = 1 } = input;
  const methodUpper = method.toUpperCase();

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

  // Truncate very large bodies to avoid blowing up the prompt
  const bodyPreview = bodyStr && bodyStr.length > 2000 ? bodyStr.slice(0, 2000) + "\n...(truncated)" : bodyStr;

  const prompt = `You are generating a summary for an API approval card. A human reviewer needs to decide whether to approve or reject this action. Be specific and thorough -- the reviewer should understand exactly what will happen without needing to inspect the raw request.

Request details:
- Method: ${methodUpper}
- URL: ${url}
- Credential/API: ${credentialName ?? "unknown"}
${bodyPreview ? `- Request body:\n\`\`\`json\n${bodyPreview}\n\`\`\`` : "- No request body"}
${itemCount > 1 ? `- Batch size: ${itemCount} items` : ""}

Respond with exactly two sections:
TITLE: A short (max 80 chars) action-oriented title. Include the key entity name. Examples: "Create lead 'Acme Corp' in Close CRM", "Delete contact john@example.com"
DESCRIPTION: A detailed summary of ALL inputs -- not just the main entity. List every meaningful field being set: custom fields, tags, status, contacts, emails, addresses, assigned users, amounts, dates, etc. Use bullet points if there are 3+ fields. The reviewer should be able to approve confidently without clicking "Review items". Do NOT just repeat the title. Be specific with actual values from the body.

IMPORTANT formatting rules (this renders in Slack, NOT Markdown):
- Bold: *text* (single asterisk, NOT **double**)
- Italic: _text_ (single underscore)
- Code: \`text\` (backticks work the same)
- Bullet points: use "• " or "- " at the start of a line
- NEVER use **double asterisks** -- Slack renders them as literal characters`;

  try {
    const { text } = await generateText({
      model: fastModel,
      prompt,
      maxTokens: 500,
      temperature: 0,
    });

    const titleMatch = text.match(/TITLE:\s*(.+)/);
    const descMatch = text.match(/DESCRIPTION:\s*([\s\S]+)/);

    if (titleMatch && descMatch) {
      return {
        title: titleMatch[1].trim().slice(0, 120),
        description: descMatch[1].trim(),
      };
    }

    // Partial parse — use what we got
    if (titleMatch) {
      return {
        title: titleMatch[1].trim().slice(0, 120),
        description: formatBodyPreview(body),
      };
    }
  } catch (err) {
    // LLM call failed — fall back to static summary
    console.warn("generateProposalSummary: LLM call failed, using fallback", err);
  }

  // Fallback: static summary (same as before but simpler)
  return staticFallback(methodUpper, url, body, credentialName, itemCount);
}

// ── Fallback (no LLM) ───────────────────────────────────────────────────────

function staticFallback(
  method: string,
  url: string,
  body: unknown,
  credentialName?: string,
  itemCount: number = 1,
): ProposalSummary {
  let urlPath: string;
  try {
    urlPath = new URL(url).pathname;
  } catch {
    urlPath = url.split("?")[0] || url || "/unknown";
  }
  const shortUrl = urlPath.length > 60 ? urlPath.slice(0, 57) + "..." : urlPath;
  const credLabel = credentialName ? ` via ${credentialName}` : "";

  return {
    title: itemCount > 1
      ? `${method} ${itemCount} requests to ${shortUrl}${credLabel}`
      : `${method} ${shortUrl}${credLabel}`,
    description: formatBodyPreview(body),
  };
}

function formatBodyPreview(body: unknown): string {
  if (!body) return "No request body";
  const json = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  if (json.length <= 300) return `\`\`\`\n${json}\n\`\`\``;
  return `\`\`\`\n${json.slice(0, 300)}\n...\n\`\`\``;
}
