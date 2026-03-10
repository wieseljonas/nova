import { Hono } from "hono";
import { verifySandboxToken, matchesUrlPattern } from "../lib/sandbox-token.js";
import { getApiCredentialWithType } from "../lib/api-credentials.js";
import { logger } from "../lib/logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

interface ProxyRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  credential_name: string;
  credential_owner: string;
  timeout_ms?: number;
}

// ── Private IP check (same as http-request.ts) ──────────────────────────────

function isPrivateIP(ip: string): boolean {
  return (
    /^10\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^127\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    /^0\./.test(ip) ||
    ip === "::1"
  );
}

// ── Route ───────────────────────────────────────────────────────────────────

export const sandboxProxyApp = new Hono();

sandboxProxyApp.post("/api/sandbox-proxy", async (c) => {
  // ── 1. Extract and verify token ────────────────────────────────────────
  const authHeader = c.req.header("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return c.json({ ok: false, error: "Missing Authorization header" }, 401);
  }

  const payload = verifySandboxToken(token);
  if (!payload) {
    return c.json({ ok: false, error: "Invalid or expired token" }, 401);
  }

  // ── 2. Parse request body ──────────────────────────────────────────────
  let req: ProxyRequest;
  try {
    req = await c.req.json<ProxyRequest>();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  if (!req.method || !req.url || !req.credential_name || !req.credential_owner) {
    return c.json(
      { ok: false, error: "Missing required fields: method, url, credential_name, credential_owner" },
      400,
    );
  }

  // ── 3. Validate method ─────────────────────────────────────────────────
  if (!payload.methods.includes(req.method)) {
    logger.warn("sandbox-proxy: method not allowed", {
      method: req.method,
      allowed: payload.methods,
      executionId: payload.executionId,
    });
    return c.json(
      { ok: false, error: `Method ${req.method} not allowed. Allowed: ${payload.methods.join(", ")}` },
      403,
    );
  }

  // ── 4. Validate credential ─────────────────────────────────────────────
  if (!payload.credentials.includes(req.credential_name)) {
    logger.warn("sandbox-proxy: credential not allowed", {
      credential: req.credential_name,
      allowed: payload.credentials,
      executionId: payload.executionId,
    });
    return c.json(
      { ok: false, error: `Credential "${req.credential_name}" not allowed by token scope` },
      403,
    );
  }

  // ── 5. Validate URL pattern ────────────────────────────────────────────
  if (!matchesUrlPattern(req.url, payload.urlPatterns)) {
    logger.warn("sandbox-proxy: URL not allowed", {
      url: req.url,
      patterns: payload.urlPatterns,
      executionId: payload.executionId,
    });
    return c.json(
      { ok: false, error: `URL "${req.url}" does not match any allowed pattern` },
      403,
    );
  }

  // ── 6. DNS check (no SSRF to private IPs) ─────────────────────────────
  try {
    const { hostname } = new URL(req.url);
    const dns = await import("node:dns/promises");
    const { address } = await dns.lookup(hostname);
    if (isPrivateIP(address)) {
      return c.json({ ok: false, error: "Requests to private IPs are not allowed" }, 403);
    }
  } catch (err: any) {
    return c.json({ ok: false, error: `DNS lookup failed: ${err.message}` }, 400);
  }

  // ── 7. Resolve credential ─────────────────────────────────────────────
  const intent = req.method === "GET" ? "read" : "write";
  // Use a system-level user ID for the proxy (the bot itself)
  const botUserId = process.env.AURA_BOT_USER_ID || "system";

  let credResult;
  try {
    credResult = await getApiCredentialWithType(
      req.credential_name,
      req.credential_owner,
      botUserId,
      intent,
    );
  } catch (err: any) {
    logger.error("sandbox-proxy: credential resolution failed", {
      credential: req.credential_name,
      error: err.message,
    });
    return c.json({ ok: false, error: `Credential error: ${err.message}` }, 500);
  }

  if (!credResult) {
    return c.json(
      { ok: false, error: `Credential "${req.credential_name}" not found or access denied` },
      403,
    );
  }

  // ── 8. Build headers with injected credential ─────────────────────────
  const headers: Record<string, string> = { ...req.headers };
  // Strip any auth headers the sandbox tried to pass
  for (const key of Object.keys(headers)) {
    if (["authorization", "x-api-key", "x-auth-token"].includes(key.toLowerCase())) {
      delete headers[key];
    }
  }

  switch (credResult.authScheme) {
    case "bearer":
    case "oauth_client":
    case "google_service_account":
      headers["Authorization"] = `Bearer ${credResult.value}`;
      break;
    case "basic": {
      let basicParsed: { username?: string; password: string };
      try {
        basicParsed = JSON.parse(credResult.value);
      } catch {
        return c.json({ ok: false, error: "basic credential has invalid JSON value" }, 500);
      }
      const encoded = Buffer.from(
        `${basicParsed.username || ""}:${basicParsed.password}`,
      ).toString("base64");
      headers["Authorization"] = `Basic ${encoded}`;
      break;
    }
    case "header": {
      let headerParsed: { key: string; value: string };
      try {
        headerParsed = JSON.parse(credResult.value);
      } catch {
        return c.json({ ok: false, error: "header credential has invalid JSON value" }, 500);
      }
      headers[headerParsed.key] = headerParsed.value;
      break;
    }
    case "query": {
      let queryParsed: { key: string; value: string };
      try {
        queryParsed = JSON.parse(credResult.value);
      } catch {
        return c.json({ ok: false, error: "query credential has invalid JSON value" }, 500);
      }
      const separator = req.url.includes("?") ? "&" : "?";
      req.url = `${req.url}${separator}${encodeURIComponent(queryParsed.key)}=${encodeURIComponent(queryParsed.value)}`;
      break;
    }
  }

  // Set Content-Type for requests with body
  if (req.body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }

  // ── 9. Make the request ────────────────────────────────────────────────
  const timeoutMs = Math.min(req.timeout_ms || 30_000, 60_000);

  logger.info("sandbox-proxy: forwarding request", {
    method: req.method,
    url: req.url,
    credential: req.credential_name,
    executionId: payload.executionId,
  });

  try {
    const response = await fetch(req.url, {
      method: req.method,
      headers,
      body: req.body
        ? typeof req.body === "string"
          ? req.body
          : JSON.stringify(req.body)
        : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    let responseBody: unknown;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      responseBody = await response.json().catch(() => null);
    }
    if (responseBody === undefined || responseBody === null) {
      const text = await response.text().catch(() => "");
      responseBody =
        text.length > 100_000 ? text.slice(0, 100_000) + "... (truncated)" : text;
    }

    return c.json({
      ok: response.ok,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseBody,
    });
  } catch (error: any) {
    logger.error("sandbox-proxy: request failed", {
      error: error.message,
      url: req.url,
      executionId: payload.executionId,
    });
    return c.json({ ok: false, error: `Request failed: ${error.message}` }, 502);
  }
});
