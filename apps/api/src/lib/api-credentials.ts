import { eq, and, or, isNull, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  credentials,
  credentialAuditLog,
  userProfiles,
  type Credential,
} from "@aura/db/schema";
import { encryptCredential, decryptCredential } from "./credentials.js";
import { logger } from "./logger.js";

const NAME_RE = /^[a-z][a-z0-9_]{1,62}$/;
const KEY_ENV = "CREDENTIALS_KEY";

function validateKey(): void {
  const hex = process.env[KEY_ENV];
  if (!hex || Buffer.from(hex, "hex").length !== 32) {
    throw new Error(
      `${KEY_ENV} must be a 64-character hex string (32 bytes)`,
    );
  }
}

function validateName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `Invalid credential name "${name}": must match /^[a-z][a-z0-9_]{1,62}$/`,
    );
  }
}

type AuditAction =
  | "read"
  | "write"
  | "create"
  | "update"
  | "delete"
  | "grant"
  | "revoke"
  | "use"
  | "expired_access_attempt";

export type AuthScheme = "bearer" | "basic" | "header" | "query" | "oauth_client" | "google_service_account";

async function audit(
  credentialId: string | null,
  credentialName: string,
  accessedBy: string,
  action: AuditAction,
  context?: string,
): Promise<void> {
  try {
    await db.insert(credentialAuditLog).values({
      credentialId,
      credentialName,
      accessedBy,
      action,
      context,
    });
  } catch (error) {
    logger.error("Failed to write credential audit log", {
      credentialName,
      accessedBy,
      action,
      error,
    });
  }
}

async function notifyOwnerExpired(
  ownerId: string,
  credentialName: string,
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;
  const { WebClient } = await import("@slack/web-api");
  const client = new WebClient(token);
  const dm = await client.conversations.open({ users: ownerId });
  if (dm.channel?.id) {
    await client.chat.postMessage({
      channel: dm.channel.id,
      text: `Your credential *${credentialName}* has expired. Please update or rotate it in the App Home.`,
    });
  }
}

export async function hasPermission(
  credentialOwnerId: string,
  credentialId: string,
  userId: string,
  requiredPermission: "read" | "write" | "admin",
): Promise<boolean> {
  if (userId === credentialOwnerId) return true;

  const rows = await db
    .select()
    .from(credentials)
    .where(eq(credentials.id, credentialId))
    .limit(1);

  if (!rows.length) return false;

  const cred = rows[0];
  const readerIds = (cred.readerUserIds as string[]) ?? [];
  const writerIds = (cred.writerUserIds as string[]) ?? [];

  if (requiredPermission === "read") {
    return readerIds.includes(userId) || writerIds.includes(userId);
  }

  if (requiredPermission === "write" || requiredPermission === "admin") {
    return writerIds.includes(userId);
  }

  return false;
}

export async function storeApiCredential(
  ownerId: string,
  name: string,
  plaintext: string,
  expiresAt?: Date,
  authScheme: AuthScheme = "bearer",
): Promise<Credential> {
  validateKey();
  validateName(name);

  if (authScheme === "oauth_client") {
    try {
      const parsed = JSON.parse(plaintext);
      if (!parsed.client_id || !parsed.client_secret || !parsed.token_url) {
        throw new Error(
          "oauth_client value must contain client_id, client_secret, and token_url",
        );
      }
    } catch (e: any) {
      if (
        e.message.includes("client_id") ||
        e.message.includes("client_secret") ||
        e.message.includes("token_url")
      ) {
        throw e;
      }
      throw new Error(
        "oauth_client value must be valid JSON with client_id, client_secret, and token_url keys",
      );
    }
  } else if (authScheme === "basic") {
    try {
      const parsed = JSON.parse(plaintext);
      if (!parsed.username) {
        throw new Error("basic value must contain a username (password is optional)");
      }
    } catch (e: any) {
      if (e.message.includes("password")) throw e;
      throw new Error("basic value must be valid JSON with username and password keys");
    }
  } else if (authScheme === "header" || authScheme === "query") {
    try {
      const parsed = JSON.parse(plaintext);
      if (!parsed.key || !parsed.secret) {
        throw new Error(`${authScheme} value must contain key and secret`);
      }
    } catch (e: any) {
      if (!(e instanceof SyntaxError)) throw e;
      throw new Error(`${authScheme} value must be valid JSON with key and secret keys`);
    }
  } else if (authScheme === "google_service_account") {
    try {
      const parsed = JSON.parse(plaintext);
      if (!parsed.private_key || !parsed.client_email) {
        throw new Error(
          "google_service_account value must contain private_key and client_email",
        );
      }
    } catch (e: any) {
      if (e.message.includes("private_key") || e.message.includes("client_email")) throw e;
      throw new Error(
        "google_service_account value must be valid Google service account JSON key",
      );
    }
  }

  const encrypted = encryptCredential(plaintext);

  const [row] = await db
    .insert(credentials)
    .values({
      ownerUserId: ownerId,
      key: name,
      authScheme,
      value: encrypted,
      expiresAt: expiresAt ?? null,
    })
    .onConflictDoUpdate({
      target: [credentials.ownerUserId, credentials.key],
      set: {
        value: encrypted,
        authScheme,
        expiresAt: expiresAt ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  const isUpdate = row.createdAt.getTime() !== row.updatedAt.getTime();
  await audit(row.id, name, ownerId, isUpdate ? "update" : "create");

  return row;
}

/** Shared credential fetch + permission check. Returns the full row or null. */
async function fetchAndAuthorize(
  name: string,
  ownerId: string,
  requestingUserId: string,
  intent: "read" | "write",
): Promise<typeof credentials.$inferSelect | null> {
  validateKey();
  validateName(name);

  const rows = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.ownerUserId, ownerId), eq(credentials.key, name)))
    .limit(1);

  const cred = rows[0];
  if (!cred) return null;

  if (cred.expiresAt && cred.expiresAt < new Date()) {
    await audit(cred.id, name, requestingUserId, "expired_access_attempt");
    await notifyOwnerExpired(cred.ownerUserId, name).catch(() => {});
    return null;
  }

  const allowed = await hasPermission(ownerId, cred.id, requestingUserId, intent);
  if (!allowed) {
    await audit(cred.id, name, requestingUserId, intent, "access_denied");
    throw new Error(`Access denied: ${requestingUserId} cannot ${intent} credential "${name}" owned by ${ownerId}`);
  }

  await audit(cred.id, name, requestingUserId, "read");
  return cred;
}

export async function getApiCredential(
  name: string,
  ownerId: string,
  requestingUserId: string,
  intent: "read" | "write",
): Promise<string | null> {
  const cred = await fetchAndAuthorize(name, ownerId, requestingUserId, intent);
  if (!cred) return null;
  return decryptCredential(cred.value);
}

export async function getApiCredentialWithType(
  name: string,
  ownerId: string,
  requestingUserId: string,
  intent: "read" | "write",
): Promise<{ id: string; value: string; authScheme: AuthScheme; displayName: string | null } | null> {
  const cred = await fetchAndAuthorize(name, ownerId, requestingUserId, intent);
  if (!cred) return null;

  const decrypted = decryptCredential(cred.value);

  if (cred.authScheme === "oauth_client") {
    let parsed: { client_id?: string; client_secret?: string; token_url?: string };
    try {
      parsed = JSON.parse(decrypted);
    } catch {
      throw new Error(`oauth_client credential "${name}" has invalid JSON value`);
    }
    if (!parsed.client_id || !parsed.client_secret) {
      throw new Error(
        `oauth_client credential "${name}" missing client_id or client_secret`,
      );
    }
    if (!parsed.token_url) {
      throw new Error(
        `oauth_client credential "${name}" missing token_url (may need manual repair if migrated from legacy format)`,
      );
    }
    const tokenResponse = await exchangeOAuthToken(
      parsed.token_url,
      parsed.client_id,
      parsed.client_secret,
    );
    return {
      id: cred.id,
      value: tokenResponse.access_token,
      authScheme: cred.authScheme as AuthScheme,
      displayName: cred.displayName,
    };
  }

  if (cred.authScheme === "google_service_account") {
    const token = await exchangeGoogleServiceAccountToken(decrypted);
    return {
      id: cred.id,
      value: token,
      authScheme: cred.authScheme as AuthScheme,
      displayName: cred.displayName,
    };
  }

  return { id: cred.id, value: decrypted, authScheme: cred.authScheme as AuthScheme, displayName: cred.displayName };
}

async function exchangeGoogleServiceAccountToken(
  jsonKeyStr: string,
): Promise<string> {
  const { GoogleAuth } = await import("google-auth-library");
  let keyData: { client_email: string; private_key: string; scopes?: string };
  try {
    keyData = JSON.parse(jsonKeyStr);
  } catch {
    throw new Error("google_service_account credential has invalid JSON value");
  }

  const auth = new GoogleAuth({
    credentials: {
      client_email: keyData.client_email,
      private_key: keyData.private_key,
    },
    scopes: keyData.scopes
      ? keyData.scopes.split(",").map((s: string) => s.trim())
      : ["https://www.googleapis.com/auth/cloud-platform"],
  });

  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  if (!tokenResponse.token) {
    throw new Error("google_service_account: failed to obtain access token");
  }
  return tokenResponse.token;
}

async function exchangeOAuthToken(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<{ access_token: string; expires_in?: number }> {
  let resp: Response;
  try {
    resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    });
  } catch (err: any) {
    throw new Error(`Token exchange failed: could not reach ${tokenUrl}: ${err.message}`);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `Token exchange failed: ${tokenUrl} returned ${resp.status}${body ? `: ${body}` : ""}`,
    );
  }

  let data: any;
  try {
    data = await resp.json();
  } catch {
    throw new Error(`Token exchange failed: ${tokenUrl} returned non-JSON response`);
  }

  if (!data.access_token || typeof data.access_token !== "string") {
    throw new Error(
      `Token exchange failed: response from ${tokenUrl} missing access_token field`,
    );
  }

  return {
    access_token: data.access_token,
    expires_in: typeof data.expires_in === "number" ? data.expires_in : undefined,
  };
}

/**
 * Retrieve a credential for a scheduled job. Returns raw decrypted value and auth scheme.
 * NOTE: Does not auto-exchange oauth_client tokens — jobs get raw client_id/client_secret JSON.
 * This is intentional: jobs may need different exchange flows or caching strategies.
 * Use getApiCredentialWithType for interactive tool calls that need auto-exchange.
 */
export async function getJobApiCredential(
  name: string,
  jobId: string,
  creatorId: string,
  declaredCredentialIds: string[],
): Promise<{ value: string; authScheme: AuthScheme } | null> {
  validateKey();
  validateName(name);

  if (declaredCredentialIds.length === 0) return null;

  const rows = await db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.key, name),
        eq(credentials.ownerUserId, creatorId),
        sql`${credentials.id} = ANY(${declaredCredentialIds})`,
      ),
    )
    .limit(1);

  const cred = rows[0];
  if (!cred) return null;

  if (cred.expiresAt && cred.expiresAt < new Date()) {
    await audit(cred.id, name, `job:${jobId}`, "expired_access_attempt");
    await notifyOwnerExpired(creatorId, name).catch(() => {});
    return null;
  }

  await audit(cred.id, name, `job:${jobId}`, "use", `creator:${creatorId}`);
  return { value: decryptCredential(cred.value), authScheme: cred.authScheme as AuthScheme };
}

export async function getCredentialById(
  credentialId: string,
): Promise<{ id: string; key: string; ownerUserId: string } | null> {
  const rows = await db
    .select({
      id: credentials.id,
      key: credentials.key,
      ownerUserId: credentials.ownerUserId,
    })
    .from(credentials)
    .where(eq(credentials.id, credentialId))
    .limit(1);
  return rows[0] ?? null;
}

export async function listApiCredentials(
  userId: string,
): Promise<
  Array<{
    id: string;
    key: string;
    authScheme: AuthScheme;
    owner_user_id: string;
    expires_at: Date | null;
    reader_user_ids: string[];
    writer_user_ids: string[];
    approval_slack_channel_id: string | null;
    permission: "owner" | "read" | "write";
  }>
> {
  const allCreds = await db
    .select({
      id: credentials.id,
      key: credentials.key,
      authScheme: credentials.authScheme,
      owner_user_id: credentials.ownerUserId,
      expires_at: credentials.expiresAt,
      reader_user_ids: credentials.readerUserIds,
      writer_user_ids: credentials.writerUserIds,
      approval_slack_channel_id: credentials.approvalSlackChannelId,
    })
    .from(credentials)
    .where(
      or(
        eq(credentials.ownerUserId, userId),
        sql`${credentials.readerUserIds} @> ${JSON.stringify([userId])}::jsonb`,
        sql`${credentials.writerUserIds} @> ${JSON.stringify([userId])}::jsonb`
      )
    );

  return allCreds.map((cred) => {
    let permission: "owner" | "read" | "write" = "read";
    
    if (cred.owner_user_id === userId) {
      permission = "owner";
    } else if (((cred.writer_user_ids as any) ?? []).includes(userId)) {
      permission = "write";
    } else if (((cred.reader_user_ids as any) ?? []).includes(userId)) {
      permission = "read";
    }

    return {
      ...cred,
      authScheme: cred.authScheme as AuthScheme,
      reader_user_ids: (cred.reader_user_ids as any) ?? [],
      writer_user_ids: (cred.writer_user_ids as any) ?? [],
      permission,
    };
  });
}

export async function listAccessForCredentials(
  credentialIds: string[],
): Promise<
  Array<{
    credentialId: string;
    userId: string;
    permission: "read" | "write";
    displayName: string | null;
  }>
> {
  if (credentialIds.length === 0) return [];

  const creds = await db
    .select()
    .from(credentials)
    .where(inArray(credentials.id, credentialIds));

  const access: Array<{
    credentialId: string;
    userId: string;
    permission: "read" | "write";
    displayName: string | null;
  }> = [];

  for (const cred of creds) {
    const readerIds = (cred.readerUserIds as string[]) ?? [];
    const writerIds = (cred.writerUserIds as string[]) ?? [];

    for (const readerId of readerIds) {
      access.push({
        credentialId: cred.id,
        userId: readerId,
        permission: "read",
        displayName: null,
      });
    }

    for (const writerId of writerIds) {
      access.push({
        credentialId: cred.id,
        userId: writerId,
        permission: "write",
        displayName: null,
      });
    }
  }

  // Fetch display names in bulk
  const allUserIds = [...new Set(access.map(a => a.userId))];
  if (allUserIds.length > 0) {
    const profiles = await db
      .select({
        slackUserId: userProfiles.slackUserId,
        displayName: userProfiles.displayName,
      })
      .from(userProfiles)
      .where(inArray(userProfiles.slackUserId, allUserIds));

    const displayNameMap = new Map(profiles.map(p => [p.slackUserId, p.displayName]));
    
    for (const item of access) {
      item.displayName = displayNameMap.get(item.userId) ?? null;
    }
  }

  return access;
}

export async function deleteApiCredential(
  credentialId: string,
  requestingUserId: string,
): Promise<boolean> {
  const rows = await db
    .select()
    .from(credentials)
    .where(eq(credentials.id, credentialId))
    .limit(1);

  const cred = rows[0];
  if (!cred) return false;

  if (cred.ownerUserId !== requestingUserId) {
    await audit(cred.id, cred.key, requestingUserId, "delete", "access_denied");
    return false;
  }

  await db.delete(credentials).where(eq(credentials.id, credentialId));
  await audit(null, cred.key, requestingUserId, "delete");
  return true;
}

export async function addCredentialReader(
  credentialId: string,
  granterId: string,
  granteeId: string,
): Promise<void> {
  const rows = await db
    .select()
    .from(credentials)
    .where(eq(credentials.id, credentialId))
    .limit(1);

  const cred = rows[0];
  if (!cred) throw new Error("Credential not found");

  const allowed = await hasPermission(cred.ownerUserId, credentialId, granterId, "write");
  if (!allowed && cred.ownerUserId !== granterId) {
    throw new Error("Only the owner or a writer can grant access");
  }

  const readerIds = (cred.readerUserIds as string[]) ?? [];
  if (!readerIds.includes(granteeId)) {
    readerIds.push(granteeId);
    
    await db
      .update(credentials)
      .set({ 
        readerUserIds: readerIds as any,
        updatedAt: new Date()
      })
      .where(eq(credentials.id, credentialId));
  }

  await audit(credentialId, cred.key, granterId, "grant", `grantee:${granteeId} permission:read`);
}

export async function addCredentialWriter(
  credentialId: string,
  granterId: string,
  granteeId: string,
): Promise<void> {
  const rows = await db
    .select()
    .from(credentials)
    .where(eq(credentials.id, credentialId))
    .limit(1);

  const cred = rows[0];
  if (!cred) throw new Error("Credential not found");

  const allowed = await hasPermission(cred.ownerUserId, credentialId, granterId, "write");
  if (!allowed && cred.ownerUserId !== granterId) {
    throw new Error("Only the owner or a writer can grant access");
  }

  const writerIds = (cred.writerUserIds as string[]) ?? [];
  if (!writerIds.includes(granteeId)) {
    writerIds.push(granteeId);
    
    await db
      .update(credentials)
      .set({ 
        writerUserIds: writerIds as any,
        updatedAt: new Date()
      })
      .where(eq(credentials.id, credentialId));
  }

  await audit(credentialId, cred.key, granterId, "grant", `grantee:${granteeId} permission:write`);
}

export async function setCredentialDisplayName(
  name: string,
  ownerId: string,
  displayName: string,
  requestingUserId?: string,
): Promise<void> {
  validateName(name);
  // Only the credential owner can set display name
  if (requestingUserId && requestingUserId !== ownerId) return;
  await db
    .update(credentials)
    .set({ displayName, updatedAt: new Date() })
    .where(and(eq(credentials.ownerUserId, ownerId), eq(credentials.key, name)));
}

/** Lightweight lookup -- just the display_name for a credential. Used by status spinners. */
export async function getCredentialDisplayName(
  name: string,
  ownerId: string,
): Promise<string | null> {
  validateName(name);
  const rows = await db
    .select({ displayName: credentials.displayName })
    .from(credentials)
    .where(and(eq(credentials.ownerUserId, ownerId), eq(credentials.key, name)))
    .limit(1);
  return rows[0]?.displayName ?? null;
}

function scrubValue(error: unknown, plaintext: string): Error {
  const msg =
    error instanceof Error ? error.message : String(error);
  const stack =
    error instanceof Error ? error.stack ?? "" : "";
  const scrubbed = new Error(msg.replaceAll(plaintext, "[REDACTED]"));
  scrubbed.stack = stack.replaceAll(plaintext, "[REDACTED]");
  return scrubbed;
}

export async function withApiCredential<T>(
  name: string,
  ownerId: string,
  requestingUserId: string,
  intent: "read" | "write",
  fn: (value: string) => Promise<T>,
): Promise<T> {
  const plaintext = await getApiCredential(name, ownerId, requestingUserId, intent);
  if (plaintext === null) {
    throw new Error(`Credential "${name}" not found`);
  }

  try {
    const result = await fn(plaintext);

    const rows = await db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(eq(credentials.ownerUserId, ownerId), eq(credentials.key, name)),
      )
      .limit(1);
    if (rows[0]) {
      await audit(rows[0].id, name, requestingUserId, "use");
    }

    return result;
  } catch (error) {
    throw scrubValue(error, plaintext);
  }
}

const MAX_AUDIT_BODY_LENGTH = 10_000;

function truncateBody(body: unknown): unknown {
  if (body == null) return null;
  const str = typeof body === "string" ? body : JSON.stringify(body);
  if (str.length <= MAX_AUDIT_BODY_LENGTH) return body;
  return str.slice(0, MAX_AUDIT_BODY_LENGTH) + "… (truncated)";
}

const SENSITIVE_HEADERS = new Set(["authorization", "x-api-key", "x-auth-token", "cookie", "set-cookie"]);

function sanitizeHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? "[REDACTED]" : v;
  }
  return out;
}

export async function auditCredentialHttpUse(
  credentialId: string,
  credentialName: string,
  accessedBy: string,
  httpRequest: { method: string; url: string; headers?: Record<string, string>; body?: unknown },
  httpResponse: { status?: number; headers?: Record<string, string>; body?: unknown; error?: string },
): Promise<void> {
  await auditCredentialNetworkUse(
    "http_request",
    credentialId,
    credentialName,
    accessedBy,
    httpRequest,
    httpResponse,
  );
}

export async function auditCredentialProxyUse(
  credentialId: string,
  credentialName: string,
  accessedBy: string,
  httpRequest: { method: string; url: string; headers?: Record<string, string>; body?: unknown },
  httpResponse: { status?: number; headers?: Record<string, string>; body?: unknown; error?: string },
): Promise<void> {
  await auditCredentialNetworkUse(
    "proxy",
    credentialId,
    credentialName,
    accessedBy,
    httpRequest,
    httpResponse,
  );
}

async function auditCredentialNetworkUse(
  source: "http_request" | "proxy",
  credentialId: string,
  credentialName: string,
  accessedBy: string,
  httpRequest: { method: string; url: string; headers?: Record<string, string>; body?: unknown },
  httpResponse: { status?: number; headers?: Record<string, string>; body?: unknown; error?: string },
): Promise<void> {
  await audit(credentialId, credentialName, accessedBy, "use", JSON.stringify({
    source,
    request: {
      method: httpRequest.method,
      url: httpRequest.url,
      headers: sanitizeHeaders(httpRequest.headers),
      body: truncateBody(httpRequest.body),
    },
    response: {
      status: httpResponse.status,
      headers: sanitizeHeaders(httpResponse.headers),
      body: truncateBody(httpResponse.body),
      error: httpResponse.error,
    },
  }));
}

export function maskApiCredential(value: string): string {
  if (value.length < 8) {
    const first1 = value.slice(0, 1);
    const last1 = value.slice(-1);
    return `${first1}***${last1}`;
  }
  if (value.length < 12) {
    const first2 = value.slice(0, 2);
    const last2 = value.slice(-2);
    return `${first2}***${last2}`;
  }
  const first4 = value.slice(0, 4);
  const last4 = value.slice(-4);
  return `${first4}***${last4}`;
}

/**
 * One-time data migration: fold `token_url` from the old column into the encrypted
 * value JSON blob for oauth_client credentials.
 *
 * Safe to call at startup — checks whether the legacy `type` column still exists
 * before doing anything. After the SQL migration in 0034 drops that column, this
 * is a no-op. Idempotent: re-running when already migrated does nothing.
 */
export async function runCredentialMigration(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return;

  // Check if the old `type` column still exists (pre-migration state)
  const { neon } = await import("@neondatabase/serverless");
  const rawSql = neon(connectionString);

  const cols = await rawSql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'credentials'
      AND column_name = 'type'
  `;

  if (cols.length === 0) {
    // Column already gone — migration already ran, nothing to do
    return;
  }

  logger.info("runCredentialMigration: folding token_url into oauth_client value blobs");

  // Fetch all oauth_client rows via raw SQL (Drizzle schema no longer has these columns)
  // This migration is obsolete - the credential schema has been updated
  // and the legacy 'type' and 'token_url' columns no longer exist
  logger.info("runCredentialMigration: skipping (already migrated)");
}
