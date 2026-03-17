import crypto from "node:crypto";

interface ProxyTokenPayload {
  sub: string;
  creds: string[];
  iat: number;
  exp: number;
}

export function mintProxyToken(args: {
  credentialKeys: string[];
  userId: string;
  ttlMinutes?: number;
}): string {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    throw new Error("CRON_SECRET is required to mint proxy tokens");
  }

  const ttlMinutes = Math.min(Math.max(args.ttlMinutes ?? 15, 1), 60);
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "HS256", typ: "JWT" };
  const payload: ProxyTokenPayload = {
    sub: args.userId,
    creds: args.credentialKeys,
    iat: now,
    exp: now + ttlMinutes * 60,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = base64UrlEncode(
    crypto.createHmac("sha256", secret).update(signingInput).digest(),
  );

  return `${signingInput}.${signature}`;
}

export function verifyProxyToken(token: string): {
  credentialKeys: string[];
  userId: string;
} {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    throw new Error("CRON_SECRET is required to verify proxy tokens");
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid proxy token format");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = base64UrlEncode(
    crypto.createHmac("sha256", secret).update(signingInput).digest(),
  );

  if (
    encodedSignature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(
      Buffer.from(encodedSignature, "utf8"),
      Buffer.from(expectedSignature, "utf8"),
    )
  ) {
    throw new Error("Invalid proxy token signature");
  }

  const header = JSON.parse(base64UrlDecode(encodedHeader).toString("utf8")) as {
    alg?: string;
    typ?: string;
  };
  if (header.alg !== "HS256" || header.typ !== "JWT") {
    throw new Error("Invalid proxy token header");
  }

  const payload = JSON.parse(
    base64UrlDecode(encodedPayload).toString("utf8"),
  ) as Partial<ProxyTokenPayload>;
  if (
    typeof payload.sub !== "string" ||
    !Array.isArray(payload.creds) ||
    payload.creds.some((c) => typeof c !== "string") ||
    typeof payload.exp !== "number"
  ) {
    throw new Error("Invalid proxy token payload");
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) {
    throw new Error("Proxy token expired");
  }

  return {
    credentialKeys: payload.creds,
    userId: payload.sub,
  };
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Buffer {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(base64 + padding, "base64");
}
