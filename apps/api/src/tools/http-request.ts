import dns from "node:dns/promises";
import { z } from "zod";
import { defineTool } from "../lib/tool.js";
import { getApiCredentialWithType, getCredentialDisplayName, auditCredentialHttpUse } from "../lib/api-credentials.js";
import { injectCredentialAuth } from "../lib/credential-auth.js";
import { logger } from "../lib/logger.js";
import type { ScheduleContext } from "@aura/db/schema";

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


export function createHttpRequestTool(context?: ScheduleContext) {
  return {
    http_request: defineTool({
      description:
        "Make a credentialed HTTP request to an external API. " +
        "The credential is injected server-side -- the LLM never sees the key value. " +
        "Use this for all external API calls that require stored credentials. " +
        "Specify credential_name (e.g. 'close_fr') and credential_owner (Slack user ID) " +
        "to inject auth. The server resolves the credential from the encrypted store and " +
        "sets the Authorization header. You CANNOT pass Authorization, x-api-key, or " +
        "x-auth-token headers directly -- use credential_name instead. " +
        "Responses larger than 100KB are automatically saved to a sandbox file; " +
        "check the `truncated` field and use `run_command` with jq/python on the returned `path` to process.",
      inputSchema: z.object({
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        url: z.string().url(),
        credential_name: z
          .string()
          .optional()
          .describe("Name of the stored credential to inject as Authorization header"),
        credential_owner: z
          .string()
          .optional()
          .describe("Slack user ID of the credential owner"),

        headers: z
          .record(z.string())
          .optional()
          .refine(
            (h) =>
              !h ||
              !Object.keys(h).some((k) =>
                ["authorization", "x-api-key", "x-auth-token"].includes(
                  k.toLowerCase(),
                ),
              ),
            {
              message:
                "Use credential_name to inject auth headers -- direct Authorization header is not allowed",
            },
          )
          .describe("Additional headers (auth headers not allowed -- use credential_name)"),
        body: z.unknown().optional().describe("Request body (will be JSON-serialized)"),
        timeout_ms: z
          .number()
          .default(30_000)
          .describe("Request timeout in milliseconds (default 30s)"),
        reason: z
          .string()
          .optional()
          .describe(
            "Brief context explaining WHY this request is being made. " +
            "Shown to the human reviewer on the approval card. " +
            "E.g. 'Creating a test lead for HITL testing as requested by Jonas'"
          ),
      }),
      execute: async (input) => {
        let credentialMeta: { id: string; name: string; userId: string } | null = null;

        try {
          const { hostname } = new URL(input.url);
          const resolved = await dns.resolve4(hostname).catch(() => [] as string[]);
          for (const ip of resolved) {
            if (isPrivateIP(ip)) {
              return {
                ok: false as const,
                error: `Blocked: ${hostname} resolves to private IP ${ip}`,
              };
            }
          }

          let headers: Record<string, string> = { ...input.headers };
          let requestUrl = input.url;

          if (input.credential_name) {
            const owner = input.credential_owner ?? context?.userId;
            if (!owner) {
              return {
                ok: false as const,
                error:
                  "credential_owner is required (or must be running in a user context)",
              };
            }

            const requestingUserId = context?.userId ?? owner;
            const credResult = await getApiCredentialWithType(
              input.credential_name,
              owner,
              requestingUserId,
              "read",
            );

            if (!credResult) {
              return {
                ok: false as const,
                error: `Credential "${input.credential_name}" not found or expired`,
              };
            }

            credentialMeta = { id: credResult.id, name: input.credential_name, userId: requestingUserId };

            try {
              if (credResult.authScheme === "query") {
                logger.warn("Using query parameter auth - secrets will be exposed in URL", {
                  credential: input.credential_name,
                  url: input.url,
                });
              }
              const injected = injectCredentialAuth(requestUrl, headers, {
                authScheme: credResult.authScheme,
                value: credResult.value,
              });
              headers = injected.headers;
              requestUrl = injected.url;
            } catch (error: any) {
              return { ok: false as const, error: error?.message || "Invalid credential format" };
            }
          }

          if (
            input.body &&
            !Object.keys(headers).some(
              (k) => k.toLowerCase() === "content-type",
            )
          ) {
            headers["Content-Type"] = "application/json";
          }

          logger.info("http_request executing", {
            method: input.method,
            url: input.url,
            hasCredential: !!input.credential_name,
          });

          const response = await fetch(requestUrl, {
            method: input.method,
            headers,
            body: input.body
              ? (typeof input.body === "string" ? input.body : JSON.stringify(input.body))
              : undefined,
            redirect: "manual",
            signal: AbortSignal.timeout(input.timeout_ms),
          });

          const MAX_RESPONSE_BYTES = 25_000_000;
          const MAX_INLINE_BYTES = 100_000;
          const PREVIEW_BYTES = 4_000;

          const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);
          if (contentLength > MAX_RESPONSE_BYTES) {
            if (credentialMeta) {
              auditCredentialHttpUse(
                credentialMeta.id, credentialMeta.name, credentialMeta.userId,
                { method: input.method, url: input.url, headers: input.headers, body: input.body },
                { status: response.status, error: `Response too large (${contentLength} bytes)` },
              ).catch(() => {});
            }
            return {
              ok: false as const,
              error: `Response too large (${contentLength} bytes). Maximum supported: ${MAX_RESPONSE_BYTES} bytes.`,
              status: response.status,
            };
          }

          const contentType = response.headers.get("content-type") ?? "";
          const text = await response.text().catch(() => "");
          const textBytes = Buffer.byteLength(text);
          const responseHeaders = Object.fromEntries(response.headers.entries());

          if (credentialMeta) {
            let auditBody: unknown = text;
            if (contentType.includes("application/json")) {
              try { auditBody = JSON.parse(text); } catch { /* keep as text */ }
            }
            auditCredentialHttpUse(
              credentialMeta.id, credentialMeta.name, credentialMeta.userId,
              { method: input.method, url: input.url, headers: input.headers, body: input.body },
              { status: response.status, headers: responseHeaders, body: auditBody },
            ).catch(() => {});
          }

          if (textBytes <= MAX_INLINE_BYTES) {
            let responseBody: unknown = text;
            if (contentType.includes("application/json")) {
              try { responseBody = JSON.parse(text); } catch { /* keep as text */ }
            }
            return {
              ok: response.ok as boolean,
              status: response.status,
              headers: responseHeaders,
              body: responseBody,
            };
          }

          const preview = text.slice(0, PREVIEW_BYTES) + "…";
          const baseResult = {
            ok: response.ok as boolean,
            status: response.status,
            headers: responseHeaders,
            body: preview,
            truncated: true as const,
            total_size_bytes: textBytes,
          };

          if (process.env.E2B_API_KEY) {
            try {
              const { writeToSandbox } = await import("../lib/sandbox.js");
              const { hostname } = new URL(input.url);
              const ext = contentType.includes("json") ? "json" : "txt";
              const filename = `${hostname.replace(/[^a-z0-9.-]/gi, "_")}-${Date.now()}.${ext}`;
              const path = await writeToSandbox(filename, Buffer.from(text), "downloads/http");
              return { ...baseResult, path };
            } catch (e: any) {
              logger.warn("http_request: failed to save large response to sandbox", { error: e.message });
              return { ...baseResult, save_error: "Failed to save to sandbox; only preview available." };
            }
          }

          return { ...baseResult, save_error: "Sandbox unavailable; only preview available." };
        } catch (error: any) {
          if (credentialMeta) {
            auditCredentialHttpUse(
              credentialMeta.id, credentialMeta.name, credentialMeta.userId,
              { method: input.method, url: input.url, headers: input.headers, body: input.body },
              { error: error.message },
            ).catch(() => {});
          }
          logger.error("http_request failed", { error: error.message, url: input.url });
          return { ok: false as const, error: `Request failed: ${error.message}` };
        }
      },
      slack: {
        status: async (input) => {
          if (input.credential_name && input.credential_owner) {
            const displayName = await getCredentialDisplayName(input.credential_name, input.credential_owner);
            return displayName ? `Using ${displayName}` : `Using ${input.credential_name}`;
          }
          return "Making HTTP request...";
        },
        detail: (input) => `${input.method} ${input.url}`,
        output: (result: any) =>
          result.ok === false && result.error
            ? result.error
            : `HTTP ${result.status}`,
      },
    }),
  };
}
