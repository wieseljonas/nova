import { z } from "zod";
import { defineTool } from "../lib/tool.js";
import { mintSandboxToken } from "../lib/sandbox-token.js";
import { getOrCreateSandbox, getSandboxEnvs } from "../lib/sandbox.js";
import { logger } from "../lib/logger.js";
import type { ScheduleContext } from "../db/schema.js";

/**
 * Create the sandbox API access tool.
 * Lets the LLM grant the sandbox scoped, time-limited access to
 * external APIs via the credential proxy -- without exposing raw
 * credentials or round-tripping every request through the LLM.
 */
export function createSandboxApiTools(context?: ScheduleContext) {
  return {
    grant_sandbox_api_access: defineTool({
      description:
        "Grant the sandbox scoped access to external APIs via a secure proxy. " +
        "Mints a short-lived token and injects NOVA_PROXY_URL and NOVA_PROXY_TOKEN " +
        "as env vars in the sandbox. The sandbox can then make credentialed API calls " +
        "directly (via curl or Python requests) without going through the LLM for each " +
        "request. The token is scoped to specific credentials, HTTP methods, and URL " +
        "patterns. Use this before running sandbox scripts that need external API access. " +
        "Example sandbox usage after granting: " +
        "curl -X POST $NOVA_PROXY_URL -H 'Authorization: Bearer $NOVA_PROXY_TOKEN' " +
        "-H 'Content-Type: application/json' -d '{\"method\":\"GET\",\"url\":\"https://api.close.com/api/v1/lead/\",\"credential_name\":\"close_fr\",\"credential_owner\":\"U066V1AN6\"}'",
      inputSchema: z.object({
        credentials: z
          .array(z.string())
          .min(1)
          .describe("Credential names the sandbox can use, e.g. ['close_fr']"),
        credential_owner: z
          .string()
          .describe("Slack user ID of the credential owner"),
        methods: z
          .array(z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]))
          .default(["GET"])
          .describe("HTTP methods allowed. Default: GET only (read-only)"),
        url_patterns: z
          .array(z.string())
          .default([])
          .describe(
            "URL patterns the sandbox can access. Glob: * = one segment, ** = any. " +
            "E.g. ['https://api.close.com/**']. Empty = allow all URLs.",
          ),
        ttl_seconds: z
          .number()
          .min(60)
          .max(3600)
          .default(600)
          .describe("Token lifetime in seconds. Default: 600 (10 min). Max: 3600 (1 hour)."),
      }),
      execute: async (input) => {
        try {
          // Generate a unique execution ID
          const executionId = `sbx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

          const token = mintSandboxToken(
            {
              executionId,
              credentials: input.credentials,
              methods: input.methods,
              urlPatterns: input.url_patterns,
            },
            input.ttl_seconds,
          );

          // Determine the proxy URL from the deployment
          const proxyUrl =
            process.env.VERCEL_URL
              ? `https://${process.env.VERCEL_URL}/api/sandbox-proxy`
              : process.env.NOVA_BASE_URL
                ? `${process.env.NOVA_BASE_URL}/api/sandbox-proxy`
                : null;

          if (!proxyUrl) {
            return {
              ok: false as const,
              error:
                "Cannot determine proxy URL. Set VERCEL_URL or NOVA_BASE_URL env var.",
            };
          }

          // Inject into sandbox
          const sandbox = await getOrCreateSandbox();
          const envs = await getSandboxEnvs();

          // Write token to a file (avoids env var length issues and process listing exposure)
          await sandbox.files.write("/home/user/.nova-proxy-token", token);
          await sandbox.commands.run(
            "chmod 600 /home/user/.nova-proxy-token",
            { timeoutMs: 5_000, envs },
          );

          // Also write a helper script for easy usage
          const helperScript = `#!/usr/bin/env python3
"""Nova API Proxy client. Auto-generated -- do not edit."""
import json, os, sys, urllib.request, urllib.error

PROXY_URL = "${proxyUrl}"
TOKEN_FILE = "/home/user/.nova-proxy-token"

def _token():
    with open(TOKEN_FILE) as f:
        return f.read().strip()

def api_request(method, url, credential_name, credential_owner="${input.credential_owner}", body=None, headers=None, timeout=30):
    """Make a credentialed API request through the Nova proxy."""
    payload = {
        "method": method,
        "url": url,
        "credential_name": credential_name,
        "credential_owner": credential_owner,
        "timeout_ms": timeout * 1000,
    }
    if headers:
        payload["headers"] = headers
    if body is not None:
        payload["body"] = body

    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        PROXY_URL,
        data=data,
        headers={
            "Authorization": f"Bearer {_token()}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout + 5) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())

def get(url, credential_name, **kw):
    return api_request("GET", url, credential_name, **kw)

def post(url, credential_name, body=None, **kw):
    return api_request("POST", url, credential_name, body=body, **kw)

def put(url, credential_name, body=None, **kw):
    return api_request("PUT", url, credential_name, body=body, **kw)

def delete(url, credential_name, **kw):
    return api_request("DELETE", url, credential_name, **kw)

if __name__ == "__main__":
    # CLI usage: python3 nova_api.py GET https://api.close.com/api/v1/lead/ close_fr
    if len(sys.argv) < 4:
        print("Usage: python3 nova_api.py METHOD URL CREDENTIAL_NAME [BODY_JSON]")
        sys.exit(1)
    method, url, cred = sys.argv[1], sys.argv[2], sys.argv[3]
    body = json.loads(sys.argv[4]) if len(sys.argv) > 4 else None
    result = api_request(method, url, cred, body=body)
    print(json.dumps(result, indent=2))
`;

          await sandbox.files.write("/home/user/nova_api.py", helperScript);

          // Also set env vars for curl-based usage
          await sandbox.commands.run(
            `echo 'export NOVA_PROXY_URL="${proxyUrl}"' >> /home/user/.bashrc && ` +
            `echo 'export NOVA_PROXY_TOKEN="$(cat /home/user/.nova-proxy-token)"' >> /home/user/.bashrc`,
            { timeoutMs: 5_000, envs },
          );

          logger.info("sandbox API access granted", {
            executionId,
            credentials: input.credentials,
            methods: input.methods,
            urlPatterns: input.url_patterns,
            ttl: input.ttl_seconds,
          });

          return {
            ok: true as const,
            executionId,
            proxyUrl,
            ttlSeconds: input.ttl_seconds,
            credentials: input.credentials,
            methods: input.methods,
            urlPatterns: input.url_patterns,
            usage: {
              python: `from nova_api import get, post\nresult = get("https://api.close.com/api/v1/lead/", "close_fr")\nprint(result["body"])`,
              curl: `curl -X POST $NOVA_PROXY_URL -H "Authorization: Bearer $(cat ~/.nova-proxy-token)" -H "Content-Type: application/json" -d '{"method":"GET","url":"https://api.close.com/api/v1/lead/","credential_name":"close_fr","credential_owner":"${input.credential_owner}"}'`,
              cli: `python3 nova_api.py GET https://api.close.com/api/v1/lead/ close_fr`,
            },
          };
        } catch (error: any) {
          logger.error("grant_sandbox_api_access failed", {
            error: error.message,
          });
          return { ok: false as const, error: error.message };
        }
      },
      slack: {
        status: "Granting sandbox API access...",
        detail: (input) =>
          `${input.credentials.join(", ")} [${input.methods.join("/")}]`,
        output: (result: any) =>
          result.ok
            ? `Granted: ${result.credentials?.join(", ")} (${result.ttlSeconds}s TTL)`
            : result.error,
      },
    }),
  };
}
