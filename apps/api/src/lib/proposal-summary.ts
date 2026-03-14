/**
 * Generate human-readable proposal titles and descriptions from HTTP request details.
 * Uses credential + URL pattern heuristics for known APIs.
 * Falls back to raw HTTP details for unknown patterns.
 */

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

// ── Known API patterns ───────────────────────────────────────────────────────

interface ApiPattern {
  credential: string;
  urlMatch: RegExp;
  methods?: string[];
  title: (match: RegExpMatchArray, method: string, body: unknown, count: number) => string;
  description: (match: RegExpMatchArray, method: string, body: unknown) => string;
}

function extractLeadName(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  // Close lead fields
  if (typeof b.name === "string") return b.name;
  if (typeof b.company === "string") return b.company;
  // Merge endpoint
  if (typeof b.source_id === "string" && typeof b.destination_id === "string") {
    return null; // Can't get names from IDs alone
  }
  return null;
}

function extractContactInfo(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof b.name === "string") parts.push(b.name);
  if (typeof b.email === "string") parts.push(b.email);
  if (Array.isArray(b.emails) && b.emails.length > 0) {
    const first = b.emails[0];
    if (typeof first === "object" && first && typeof (first as any).email === "string") {
      parts.push((first as any).email);
    }
  }
  return parts.length > 0 ? parts.join(" / ") : null;
}

function truncateId(id: string): string {
  if (id.length <= 20) return id;
  return id.slice(0, 10) + "..." + id.slice(-6);
}

const CLOSE_PATTERNS: ApiPattern[] = [
  {
    credential: "close_fr",
    urlMatch: /\/api\/v1\/lead\/merge\/?$/,
    methods: ["POST"],
    title: (_m, _method, body, count) => {
      const b = body as Record<string, unknown> | null;
      if (b?.source_id && b?.destination_id) {
        return `Merge Close leads (${truncateId(String(b.source_id))} → ${truncateId(String(b.destination_id))})`;
      }
      return count > 1 ? `Merge ${count} Close lead pairs` : "Merge Close leads";
    },
    description: (_m, _method, body) => {
      const b = body as Record<string, unknown> | null;
      if (b?.source_id && b?.destination_id) {
        return `Source (deleted): \`${b.source_id}\`\nDestination (kept): \`${b.destination_id}\``;
      }
      return "Merge duplicate leads in Close CRM";
    },
  },
  {
    credential: "close_fr",
    urlMatch: /\/api\/v1\/lead\/([^/]+)\/?$/,
    methods: ["PUT", "PATCH"],
    title: (match, _method, body, count) => {
      const name = extractLeadName(body);
      if (count > 1) return `Update ${count} Close leads`;
      return name ? `Update Close lead: ${name}` : `Update Close lead ${truncateId(match[1])}`;
    },
    description: (match, _method, body) => {
      const fields = body && typeof body === "object" ? Object.keys(body as object) : [];
      return `Lead: \`${match[1]}\`\nFields: ${fields.join(", ") || "unknown"}`;
    },
  },
  {
    credential: "close_fr",
    urlMatch: /\/api\/v1\/lead\/?$/,
    methods: ["POST"],
    title: (_m, _method, body, count) => {
      const name = extractLeadName(body);
      if (count > 1) return `Create ${count} Close leads`;
      return name ? `Create Close lead: ${name}` : "Create Close lead";
    },
    description: (_m, _method, body) => {
      const name = extractLeadName(body);
      return name ? `New lead: ${name}` : "Create a new lead in Close CRM";
    },
  },
  {
    credential: "close_fr",
    urlMatch: /\/api\/v1\/lead\/([^/]+)\/?$/,
    methods: ["DELETE"],
    title: (match, _method, _body, count) => {
      return count > 1 ? `Delete ${count} Close leads` : `Delete Close lead ${truncateId(match[1])}`;
    },
    description: (match) => `Lead: \`${match[1]}\``,
  },
  {
    credential: "close_fr",
    urlMatch: /\/api\/v1\/contact\/?$/,
    methods: ["POST"],
    title: (_m, _method, body, count) => {
      const info = extractContactInfo(body);
      if (count > 1) return `Create ${count} Close contacts`;
      return info ? `Create Close contact: ${info}` : "Create Close contact";
    },
    description: (_m, _method, body) => {
      const info = extractContactInfo(body);
      return info ? `New contact: ${info}` : "Create a new contact in Close CRM";
    },
  },
  {
    credential: "close_fr",
    urlMatch: /\/api\/v1\/([a-z_]+)\/?/,
    title: (match, method, _body, count) => {
      const resource = match[1].replace(/_/g, " ");
      if (count > 1) return `${method} ${count} Close ${resource} records`;
      return `${method} Close ${resource}`;
    },
    description: (match, method) => `${method} on Close CRM /${match[1]}/`,
  },
];

const BIGQUERY_PATTERNS: ApiPattern[] = [
  {
    credential: "bigquery",
    urlMatch: /bigquery.*\/queries$/,
    methods: ["POST"],
    title: (_m, _method, body, _count) => {
      const b = body as Record<string, unknown> | null;
      const query = typeof b?.query === "string" ? b.query : null;
      if (query) {
        const trimmed = query.trim().split("\n")[0].slice(0, 60);
        return `Run BigQuery: ${trimmed}${trimmed !== query.trim() ? "..." : ""}`;
      }
      return "Run BigQuery query";
    },
    description: (_m, _method, body) => {
      const b = body as Record<string, unknown> | null;
      const query = typeof b?.query === "string" ? b.query : "unknown";
      return `\`\`\`\n${query.slice(0, 500)}${query.length > 500 ? "\n..." : ""}\n\`\`\``;
    },
  },
];

const ALL_PATTERNS = [...CLOSE_PATTERNS, ...BIGQUERY_PATTERNS];

// ── Public API ───────────────────────────────────────────────────────────────

export function generateProposalSummary(input: ProposalSummaryInput): ProposalSummary {
  const { credentialName, method, url, body, itemCount = 1 } = input;
  const methodUpper = method.toUpperCase();

  // Try known patterns
  if (credentialName) {
    for (const pattern of ALL_PATTERNS) {
      if (pattern.credential !== credentialName) continue;
      if (pattern.methods && !pattern.methods.includes(methodUpper)) continue;
      const match = url.match(pattern.urlMatch);
      if (match) {
        return {
          title: pattern.title(match, methodUpper, body, itemCount),
          description: pattern.description(match, methodUpper, body),
        };
      }
    }
  }

  // Fallback: generic but clean
  let urlPath: string;
  try {
    urlPath = new URL(url).pathname;
  } catch {
    // url may be empty, relative, or malformed — fall back to string splitting
    urlPath = url.split("?")[0] || url || "/unknown";
  }
  const shortUrl = urlPath.length > 60 ? urlPath.slice(0, 57) + "..." : urlPath;
  const credLabel = credentialName ? ` via ${credentialName}` : "";

  return {
    title: itemCount > 1
      ? `${methodUpper} ${itemCount} requests to ${shortUrl}${credLabel}`
      : `${methodUpper} ${shortUrl}${credLabel}`,
    description: formatBodyPreview(body),
  };
}

function formatBodyPreview(body: unknown): string {
  if (!body) return "No request body";
  const json = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  if (json.length <= 300) return `\`\`\`\n${json}\n\`\`\``;
  return `\`\`\`\n${json.slice(0, 300)}\n...\n\`\`\``;
}
