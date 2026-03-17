import crypto from "node:crypto";

const DEFAULT_TTL_MINUTES = 15;
const PROXY_URL_FALLBACK = "https://aura-alpha-five.vercel.app/proxy";

export interface ProxyCredentialGrant {
  credentialKey: string;
  credentialOwner: string;
}

interface ProxyTokenPayload {
  sub: string;
  creds: string[];
  iat: number;
  exp: number;
}

function getSigningSecret(): string {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    throw new Error("CRON_SECRET is not configured");
  }
  return secret;
}

function toBase64Url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + "=".repeat(padding), "base64");
}

function parseJsonPart<T>(input: string, label: string): T {
  try {
    return JSON.parse(fromBase64Url(input).toString("utf8")) as T;
  } catch {
    throw new Error(`Invalid proxy token ${label}`);
  }
}

export function getProxySessionTokenSettingKey(userId: string): string {
  return `proxy_session_token:${userId}`;
}

export function getProxySessionGrantsSettingKey(userId: string): string {
  return `proxy_session_grants:${userId}`;
}

export function getProxyBaseUrl(): string {
  return process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/proxy`
    : PROXY_URL_FALLBACK;
}

export function mintProxyToken(args: {
  credentialKeys: string[];
  userId: string;
  ttlMinutes?: number;
}): string {
  const credentialKeys = [...new Set(args.credentialKeys)].filter(Boolean);
  if (credentialKeys.length === 0) {
    throw new Error("Proxy token requires at least one credential key");
  }

  const now = Math.floor(Date.now() / 1000);
  const ttlMinutes = args.ttlMinutes ?? DEFAULT_TTL_MINUTES;
  const payload: ProxyTokenPayload = {
    sub: args.userId,
    creds: credentialKeys,
    iat: now,
    exp: now + ttlMinutes * 60,
  };

  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = toBase64Url(
    crypto.createHmac("sha256", getSigningSecret()).update(unsigned).digest(),
  );

  return `${unsigned}.${signature}`;
}

export function verifyProxyToken(token: string): {
  credentialKeys: string[];
  userId: string;
} {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid proxy token format");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJsonPart<{ alg?: string; typ?: string }>(
    encodedHeader,
    "header",
  );
  if (header.alg !== "HS256" || header.typ !== "JWT") {
    throw new Error("Invalid proxy token header");
  }

  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const expected = crypto
    .createHmac("sha256", getSigningSecret())
    .update(unsigned)
    .digest();
  const provided = fromBase64Url(encodedSignature);
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    throw new Error("Invalid proxy token signature");
  }

  const payload = parseJsonPart<ProxyTokenPayload>(encodedPayload, "payload");
  if (
    typeof payload.sub !== "string" ||
    !Array.isArray(payload.creds) ||
    !payload.creds.every((cred) => typeof cred === "string" && cred.length > 0)
  ) {
    throw new Error("Invalid proxy token payload");
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    payload.exp <= now
  ) {
    throw new Error("Proxy token expired");
  }

  return {
    credentialKeys: payload.creds,
    userId: payload.sub,
  };
}
