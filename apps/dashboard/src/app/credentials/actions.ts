"use server";

import { db } from "@/lib/db";
import { credentials, credentialAuditLog, userProfiles } from "@schema";
import { and, desc, eq, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { encryptCredential, decryptCredential, maskCredential } from "@/lib/credentials";
import { revalidatePath } from "next/cache";

type AuthScheme =
  | "bearer"
  | "basic"
  | "header"
  | "query"
  | "oauth_client"
  | "google_service_account";

export interface CredentialListFilters {
  ownerUserId?: string;
  authScheme?: AuthScheme;
  expired?: "yes" | "no";
  hasAccessUserId?: string;
}

interface SecretPayloadInput {
  token?: string;
  username?: string;
  password?: string;
  key?: string;
  secret?: string;
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
  serviceAccountJson?: string;
}

function requireText(value: string | undefined, field: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  return trimmed;
}

function parseAuthScheme(value: string): AuthScheme {
  const allowed: AuthScheme[] = [
    "bearer",
    "basic",
    "header",
    "query",
    "oauth_client",
    "google_service_account",
  ];
  if (!allowed.includes(value as AuthScheme)) {
    throw new Error(`Unsupported auth scheme: ${value}`);
  }
  return value as AuthScheme;
}

function normalizeSecretPayload(authScheme: AuthScheme, input: SecretPayloadInput): string {
  switch (authScheme) {
    case "bearer":
      return requireText(input.token, "Token");
    case "basic":
      return JSON.stringify({
        username: requireText(input.username, "Username"),
        password: input.password ?? "",
      });
    case "header": {
      const key = requireText(input.key, "Header key");
      if (!/^[a-zA-Z0-9\-_]+$/.test(key)) {
        throw new Error("Header key must contain only letters, numbers, hyphens, and underscores");
      }
      return JSON.stringify({
        key,
        secret: requireText(input.secret, "Header secret"),
      });
    }
    case "query":
      return JSON.stringify({
        key: requireText(input.key, "Query key"),
        secret: requireText(input.secret, "Query secret"),
      });
    case "oauth_client": {
      const tokenUrl = requireText(input.tokenUrl, "Token URL");
      try {
        new URL(tokenUrl);
      } catch {
        throw new Error("Token URL must be a valid URL");
      }
      return JSON.stringify({
        client_id: requireText(input.clientId, "Client ID"),
        client_secret: requireText(input.clientSecret, "Client secret"),
        token_url: tokenUrl,
      });
    }
    case "google_service_account": {
      const payload = requireText(input.serviceAccountJson, "Service account JSON");
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        throw new Error("Service account JSON must be valid JSON");
      }
      if (!parsed.private_key || !parsed.client_email) {
        throw new Error("Service account JSON must include private_key and client_email");
      }
      return JSON.stringify(parsed);
    }
  }
}

function normalizeOptional(value?: string): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function getCredentialById(id: string) {
  const [cred] = await db.select().from(credentials).where(eq(credentials.id, id));
  if (!cred) {
    throw new Error("Credential not found");
  }
  return cred;
}

function canManage(credential: typeof credentials.$inferSelect, actorUserId: string): boolean {
  if (credential.ownerUserId === actorUserId) {
    return true;
  }
  const writerIds = (credential.writerUserIds as string[]) ?? [];
  return writerIds.includes(actorUserId);
}

function parseDate(value?: string): Date | null {
  if (!value || !value.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid date format");
  }
  return parsed;
}

export async function getCredentials(
  search?: string,
  page = 1,
  limit = 100,
  filters: CredentialListFilters = {},
) {
  const offset = (page - 1) * limit;
  const clauses: any[] = [];

  if (search?.trim()) {
    clauses.push(
      or(
        ilike(credentials.key, `%${search.trim()}%`),
        ilike(credentials.displayName, `%${search.trim()}%`),
      ),
    );
  }
  if (filters.ownerUserId?.trim()) {
    clauses.push(eq(credentials.ownerUserId, filters.ownerUserId.trim()));
  }
  if (filters.authScheme) {
    clauses.push(eq(credentials.authScheme, filters.authScheme));
  }
  if (filters.expired === "yes") {
    clauses.push(lt(credentials.expiresAt, new Date()));
  }
  if (filters.expired === "no") {
    clauses.push(or(isNull(credentials.expiresAt), sql`${credentials.expiresAt} >= now()`));
  }
  if (filters.hasAccessUserId?.trim()) {
    const accessUserId = filters.hasAccessUserId.trim();
    clauses.push(
      sql`${credentials.ownerUserId} = ${accessUserId}
        OR ${credentials.readerUserIds} @> ${JSON.stringify([accessUserId])}::jsonb
        OR ${credentials.writerUserIds} @> ${JSON.stringify([accessUserId])}::jsonb`,
    );
  }
  const where = clauses.length > 0 ? and(...clauses) : undefined;

  const [{ value: total }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(credentials)
    .where(where);

  const creds = await db
    .select({
      id: credentials.id,
      key: credentials.key,
      authScheme: credentials.authScheme,
      ownerUserId: credentials.ownerUserId,
      readerUserIds: credentials.readerUserIds,
      writerUserIds: credentials.writerUserIds,
      expiresAt: credentials.expiresAt,
      createdAt: credentials.createdAt,
    })
    .from(credentials)
    .where(where)
    .orderBy(desc(credentials.createdAt))
    .limit(limit)
    .offset(offset);

  const ownerIds = [...new Set(creds.map((cred) => cred.ownerUserId))];
  const ownerMap: Record<string, string> = {};
  if (ownerIds.length > 0) {
    const owners = await db
      .select({ slackUserId: userProfiles.slackUserId, displayName: userProfiles.displayName })
      .from(userProfiles)
      .where(inArray(userProfiles.slackUserId, ownerIds));

    for (const owner of owners) {
      ownerMap[owner.slackUserId] = owner.displayName ?? owner.slackUserId;
    }
  }

  const items = creds.map((cred) => {
    const readerIds = (cred.readerUserIds as string[]) ?? [];
    const writerIds = (cred.writerUserIds as string[]) ?? [];
    return {
      id: cred.id,
      key: cred.key,
      authScheme: cred.authScheme,
      ownerUserId: cred.ownerUserId,
      expiresAt: cred.expiresAt,
      createdAt: cred.createdAt,
      accessCount: readerIds.length + writerIds.length,
      ownerName: ownerMap[cred.ownerUserId] ?? cred.ownerUserId,
    };
  });

  return { items, total };
}

export async function getCredential(id: string) {
  const [cred] = await db.select().from(credentials).where(eq(credentials.id, id));
  if (!cred) return null;

  let maskedValue = "";
  try {
    maskedValue = maskCredential(decryptCredential(cred.value));
  } catch {
    maskedValue = "••••••••";
  }

  const readerIds = (cred.readerUserIds as string[]) ?? [];
  const writerIds = (cred.writerUserIds as string[]) ?? [];
  const allUserIds = [...new Set([cred.ownerUserId, ...readerIds, ...writerIds])];

  const userNames: Record<string, string> = {};
  if (allUserIds.length > 0) {
    const users = await db
      .select({ slackUserId: userProfiles.slackUserId, displayName: userProfiles.displayName })
      .from(userProfiles)
      .where(inArray(userProfiles.slackUserId, allUserIds));

    for (const user of users) {
      userNames[user.slackUserId] = user.displayName ?? user.slackUserId;
    }
  }

  const access = [
    ...writerIds.map((userId) => ({ userId, permission: "write" as const })),
    ...readerIds.map((userId) => ({ userId, permission: "read" as const })),
  ];

  const auditLog = await db
    .select()
    .from(credentialAuditLog)
    .where(eq(credentialAuditLog.credentialId, id))
    .orderBy(desc(credentialAuditLog.timestamp))
    .limit(50);

  const knownUsers = await db
    .select({ slackUserId: userProfiles.slackUserId, displayName: userProfiles.displayName })
    .from(userProfiles)
    .orderBy(desc(userProfiles.interactionCount))
    .limit(200);

  return {
    ...cred,
    maskedValue,
    ownerName: userNames[cred.ownerUserId] ?? cred.ownerUserId,
    access,
    userNames,
    knownUsers: knownUsers.map((user) => ({
      userId: user.slackUserId,
      label: user.displayName ?? user.slackUserId,
    })),
    auditLog,
  };
}

export async function createCredential(data: {
  key: string;
  authScheme: AuthScheme;
  ownerUserId: string;
  secret: SecretPayloadInput;
  displayName?: string;
  description?: string;
  approvalSlackChannelId?: string;
  expiresAt?: string;
}) {
  const key = requireText(data.key, "Key").toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(key)) {
    throw new Error("Key must start with a letter and use only lowercase letters, numbers, and underscores");
  }
  const ownerUserId = requireText(data.ownerUserId, "Owner Slack User ID");
  const authScheme = parseAuthScheme(data.authScheme);
  const normalizedSecret = normalizeSecretPayload(authScheme, data.secret);
  const encrypted = encryptCredential(normalizedSecret);

  const [cred] = await db
    .insert(credentials)
    .values({
      key,
      authScheme,
      ownerUserId,
      value: encrypted,
      displayName: normalizeOptional(data.displayName),
      description: normalizeOptional(data.description),
      approvalSlackChannelId: normalizeOptional(data.approvalSlackChannelId),
      expiresAt: parseDate(data.expiresAt),
    })
    .returning();

  revalidatePath("/credentials");
  return cred;
}

export async function updateCredentialValue(id: string, secret: SecretPayloadInput) {
  const cred = await getCredentialById(id);
  const authScheme = parseAuthScheme(cred.authScheme);
  const normalizedSecret = normalizeSecretPayload(authScheme, secret);
  const encrypted = encryptCredential(normalizedSecret);

  await db
    .update(credentials)
    .set({ value: encrypted, updatedAt: new Date() })
    .where(eq(credentials.id, id));
  revalidatePath(`/credentials/${id}`);
}

export async function grantCredentialAccess(data: {
  credentialId: string;
  actorUserId: string;
  granteeUserId: string;
  permission: "read" | "write";
}) {
  const credentialId = requireText(data.credentialId, "Credential ID");
  const actorUserId = requireText(data.actorUserId, "Acting user ID");
  const granteeUserId = requireText(data.granteeUserId, "Grantee user ID");
  if (granteeUserId === actorUserId) {
    throw new Error("Granting access to yourself is unnecessary");
  }

  const cred = await getCredentialById(credentialId);
  if (!canManage(cred, actorUserId)) {
    throw new Error("Only the owner or a writer can grant access");
  }

  const readerIds = new Set((cred.readerUserIds as string[]) ?? []);
  const writerIds = new Set((cred.writerUserIds as string[]) ?? []);

  if (data.permission === "read") {
    readerIds.add(granteeUserId);
  } else {
    writerIds.add(granteeUserId);
  }

  await db
    .update(credentials)
    .set({
      readerUserIds: [...readerIds],
      writerUserIds: [...writerIds],
      updatedAt: new Date(),
    })
    .where(eq(credentials.id, credentialId));

  await db.insert(credentialAuditLog).values({
    credentialId,
    credentialName: cred.key,
    accessedBy: actorUserId,
    action: "grant",
    context: `grantee:${granteeUserId} permission:${data.permission}`,
  });

  revalidatePath("/credentials");
  revalidatePath(`/credentials/${credentialId}`);
}

export async function revokeCredentialAccess(data: {
  credentialId: string;
  actorUserId: string;
  granteeUserId: string;
  permission: "read" | "write";
}) {
  const credentialId = requireText(data.credentialId, "Credential ID");
  const actorUserId = requireText(data.actorUserId, "Acting user ID");
  const granteeUserId = requireText(data.granteeUserId, "Grantee user ID");

  const cred = await getCredentialById(credentialId);
  if (!canManage(cred, actorUserId)) {
    throw new Error("Only the owner or a writer can revoke access");
  }
  if (granteeUserId === cred.ownerUserId) {
    throw new Error("Cannot revoke owner access");
  }

  const readerIds = new Set((cred.readerUserIds as string[]) ?? []);
  const writerIds = new Set((cred.writerUserIds as string[]) ?? []);

  if (data.permission === "read") {
    readerIds.delete(granteeUserId);
  } else {
    writerIds.delete(granteeUserId);
  }

  await db
    .update(credentials)
    .set({
      readerUserIds: [...readerIds],
      writerUserIds: [...writerIds],
      updatedAt: new Date(),
    })
    .where(eq(credentials.id, credentialId));

  await db.insert(credentialAuditLog).values({
    credentialId,
    credentialName: cred.key,
    accessedBy: actorUserId,
    action: "revoke",
    context: `grantee:${granteeUserId} permission:${data.permission}`,
  });

  revalidatePath("/credentials");
  revalidatePath(`/credentials/${credentialId}`);
}

export async function updateCredentialMetadata(data: {
  credentialId: string;
  actorUserId: string;
  displayName?: string;
  description?: string;
  approvalSlackChannelId?: string;
  expiresAt?: string;
}) {
  const credentialId = requireText(data.credentialId, "Credential ID");
  const actorUserId = requireText(data.actorUserId, "Acting user ID");
  const cred = await getCredentialById(credentialId);

  if (!canManage(cred, actorUserId)) {
    throw new Error("Only the owner or a writer can edit metadata");
  }

  await db
    .update(credentials)
    .set({
      displayName: normalizeOptional(data.displayName),
      description: normalizeOptional(data.description),
      approvalSlackChannelId: normalizeOptional(data.approvalSlackChannelId),
      expiresAt: parseDate(data.expiresAt),
      updatedAt: new Date(),
    })
    .where(eq(credentials.id, credentialId));

  await db.insert(credentialAuditLog).values({
    credentialId,
    credentialName: cred.key,
    accessedBy: actorUserId,
    action: "update",
    context: "metadata update via dashboard",
  });

  revalidatePath("/credentials");
  revalidatePath(`/credentials/${credentialId}`);
}

export async function deleteCredential(id: string) {
  await db.delete(credentials).where(eq(credentials.id, id));
  revalidatePath("/credentials");
}
