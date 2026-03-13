import { WebClient } from "@slack/web-api";
import { eq, and, isNull, sql } from "drizzle-orm";
import { generateText } from "ai";
import { db } from "../db/client.js";
import {
  approvalPolicies,
  credentials,
  type ApprovalPolicy,
  type ScheduleContext,
} from "@aura/db/schema";
import { getMainModel } from "./ai.js";
import { logger } from "./logger.js";

export type { ApprovalPolicy };

// ── Types ───────────────────────────────────────────────────────────────────

export interface ExecutionContext {
  userId?: string;
  channelId?: string;
  threadTs?: string;
  jobId?: string;
  triggerType: "user_message" | "scheduled_job" | "autonomous";
}

// ── URL Pattern Matching ────────────────────────────────────────────────────

/**
 * Simple glob matcher for URL patterns.
 * Supports `*` (match one path segment) and `**` (match any number of segments).
 * Strips protocol from both pattern and URL before matching.
 */
function matchUrlPattern(pattern: string, url: string): boolean {
  const stripProtocol = (s: string) => s.replace(/^https?:\/\//, "");
  const normalizedUrl = stripProtocol(url).replace(/\/$/, "");
  const normalizedPattern = stripProtocol(pattern).replace(/\/$/, "");

  const regexStr = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§")
    .replace(/\*/g, "[^/]+")
    .replace(/§§/g, ".*");

  return new RegExp(`^${regexStr}$`).test(normalizedUrl);
}

/**
 * Compute a specificity score for a pattern so more specific matches win.
 * Fewer wildcards and more literal segments = higher specificity.
 */
function patternSpecificity(pattern: string): number {
  const stripped = pattern.replace(/^https?:\/\//, "");
  const segments = stripped.split("/");
  let score = 0;
  for (const seg of segments) {
    if (seg === "**") score += 0;
    else if (seg.includes("*")) score += 1;
    else score += 2;
  }
  return score;
}

// ── Default Risk Tier by HTTP Method ────────────────────────────────────────

const METHOD_DEFAULT_TIER: Record<string, "read" | "write" | "destructive"> = {
  GET: "read",
  HEAD: "read",
  OPTIONS: "read",
  POST: "write",
  PUT: "write",
  PATCH: "write",
  DELETE: "destructive",
};

// ── Policy Lookup ───────────────────────────────────────────────────────────

export async function lookupPolicy(args: {
  toolName: string;
  url?: string;
  method?: string;
  credentialName?: string;
}): Promise<ApprovalPolicy | null> {
  const rows = await db
    .select()
    .from(approvalPolicies)
    .orderBy(sql`${approvalPolicies.priority} DESC`);

  for (const policy of rows) {
    if (args.toolName === "http_request") {
      // Check URL pattern match
      if (policy.urlPattern && args.url) {
        if (!matchUrlPattern(policy.urlPattern, args.url)) continue;
      } else if (policy.toolPattern !== "http_request" && policy.toolPattern !== null) {
        continue;
      }

      // Check method match
      if (
        policy.httpMethods &&
        policy.httpMethods.length > 0 &&
        args.method &&
        !policy.httpMethods.includes(args.method.toUpperCase())
      ) {
        continue;
      }

      // Check credential match
      if (
        policy.credentialName &&
        args.credentialName &&
        policy.credentialName !== args.credentialName
      ) {
        continue;
      }

      // First match wins (policies are ordered by priority DESC)
      return policy;
    } else {
      if (policy.toolPattern === args.toolName) {
        return policy;
      }
    }
  }

  return null;
}

/**
 * Determine the effective action for a tool invocation based on policy.
 * Returns: require_approval | auto_approve | deny
 * If no policy matches, defaults to auto_approve for GET, require_approval otherwise.
 */
export function effectiveAction(
  policy: ApprovalPolicy | null,
  method?: string,
): "require_approval" | "auto_approve" | "deny" {
  if (policy) return policy.action as "require_approval" | "auto_approve" | "deny";
  // Default: auto-approve reads, require approval for writes
  if (method && METHOD_DEFAULT_TIER[method.toUpperCase()] === "read") {
    return "auto_approve";
  }
  return "require_approval";
}

/**
 * Determine the effective risk tier for a tool invocation (for logging/display).
 * Maps from method to risk tier for display purposes.
 */
export function effectiveRiskTier(
  method?: string,
): "read" | "write" | "destructive" {
  if (method) return METHOD_DEFAULT_TIER[method.toUpperCase()] ?? "write";
  return "write";
}

