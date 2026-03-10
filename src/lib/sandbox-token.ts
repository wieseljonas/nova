import crypto from "node:crypto";
import { logger } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SandboxTokenPayload {
  /** Unique execution/job ID -- binds token to a single run */
  executionId: string;
  /** Which credentials the sandbox can use (by name) */
  credentials: string[];
  /** Allowed HTTP methods (e.g. ["GET"] for read-only) */
  methods: ("GET" | "POST" | "PUT" | "PATCH" | "DELETE")[];
  /** URL patterns the sandbox can access (glob: * = one segment, ** = any) */
  urlPatterns: string[];
  /** Expiry as Unix timestamp (seconds) */
  exp: number;
}

// ── Secret ──────────────────────────────────────────────────────────────────

function getSecret(): Buffer {
  // Reuse CREDENTIALS_KEY (already a 32-byte hex secret) for HMAC signing.
  // This avoids adding a new env var. The HMAC is a different use (signing
  // vs encryption) so key reuse here is acceptable -- the domains are
  // cryptographically separated by the HMAC construction.
  const hex = process.env.CREDENTIALS_KEY;
  if (!hex || Buffer.from(hex, "hex").length !== 32) {
    throw new Error(
      "CREDENTIALS_KEY must be set (64-char hex) for sandbox token signing",
    );
  }
  return Buffer.from(hex, "hex");
}

// ── Mint ────────────────────────────────────────────────────────────────────

/**
 * Create a signed, scoped, ephemeral token for sandbox API access.
 * The token is a base64url-encoded JSON payload + HMAC-SHA256 signature.
 */
export function mintSandboxToken(
  payload: Omit<SandboxTokenPayload, "exp">,
  ttlSeconds = 600, // 10 minutes default
): string {
  const full: SandboxTokenPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const json = JSON.stringify(full);
  const payloadB64 = Buffer.from(json).toString("base64url");
  const sig = crypto
    .createHmac("sha256", getSecret())
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}.${sig}`;
}

// ── Verify ──────────────────────────────────────────────────────────────────

/**
 * Verify and decode a sandbox token. Returns null if invalid or expired.
 */
export function verifySandboxToken(
  token: string,
): SandboxTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadB64, sig] = parts;
  const expectedSig = crypto
    .createHmac("sha256", getSecret())
    .update(payloadB64)
    .digest("base64url");

  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    logger.warn("sandbox-token: signature mismatch");
    return null;
  }

  let payload: SandboxTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  } catch {
    logger.warn("sandbox-token: invalid JSON payload");
    return null;
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) {
    logger.warn("sandbox-token: expired", { exp: payload.exp });
    return null;
  }

  return payload;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Check if a URL matches any of the allowed patterns.
 * Supports * (one path segment) and ** (any segments).
 */
export function matchesUrlPattern(
  url: string,
  patterns: string[],
): boolean {
  if (patterns.length === 0) return true; // no restrictions = allow all
  const stripProtocol = (s: string) => s.replace(/^https?:\/\//, "");
  const normalizedUrl = stripProtocol(url).replace(/\/$/, "");

  for (const pattern of patterns) {
    const normalizedPattern = stripProtocol(pattern).replace(/\/$/, "");
    const regexStr = normalizedPattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "§§")
      .replace(/\*/g, "[^/]+")
      .replace(/§§/g, ".*");
    if (new RegExp(`^${regexStr}$`).test(normalizedUrl)) return true;
  }
  return false;
}
