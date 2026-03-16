import type { AuthScheme } from "./api-credentials.js";

export interface ResolvedCredentialAuth {
  authScheme: AuthScheme;
  value: string;
}

export interface AuthInjectionResult {
  headers: Record<string, string>;
  url: string;
}

/**
 * Inject credential auth into request headers/URL.
 * Returns transformed headers and URL, or throws on invalid credential payload shape.
 */
export function injectCredentialAuth(
  requestUrl: string,
  baseHeaders: Record<string, string> | undefined,
  credential: ResolvedCredentialAuth | null | undefined,
): AuthInjectionResult {
  const headers: Record<string, string> = { ...(baseHeaders ?? {}) };
  let url = requestUrl;

  if (!credential) {
    return { headers, url };
  }

  switch (credential.authScheme) {
    case "bearer":
    case "oauth_client":
    case "google_service_account":
      headers.Authorization = `Bearer ${credential.value}`;
      break;

    case "basic": {
      let parsed: { username: string; password?: string };
      try {
        parsed = JSON.parse(credential.value);
      } catch {
        parsed = { username: credential.value, password: "" };
      }
      const encoded = Buffer.from(
        `${parsed.username}:${parsed.password ?? ""}`,
      ).toString("base64");
      headers.Authorization = `Basic ${encoded}`;
      break;
    }

    case "header": {
      let parsed: { key: string; secret: string };
      try {
        parsed = JSON.parse(credential.value);
      } catch {
        throw new Error("header auth credential value must be valid JSON");
      }
      if (!parsed.key || !parsed.secret) {
        throw new Error("header auth credential must include key and secret");
      }
      if (!/^[a-zA-Z0-9\-_]+$/.test(parsed.key)) {
        throw new Error(
          `Invalid header name "${parsed.key}": must contain only alphanumeric characters, hyphens, and underscores`,
        );
      }
      headers[parsed.key] = parsed.secret;
      break;
    }

    case "query": {
      let parsed: { key: string; secret: string };
      try {
        parsed = JSON.parse(credential.value);
      } catch {
        throw new Error("query auth credential value must be valid JSON");
      }
      if (!parsed.key || !parsed.secret) {
        throw new Error("query auth credential must include key and secret");
      }
      const urlObj = new URL(url);
      urlObj.searchParams.set(parsed.key, parsed.secret);
      url = urlObj.toString();
      break;
    }
  }

  return { headers, url };
}
