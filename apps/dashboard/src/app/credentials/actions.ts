"use server";

import { db } from "@/lib/db";
import { credentials, credentialAuditLog, userProfiles } from "@schema";
import { eq, desc, count, ilike, sql } from "drizzle-orm";
import { encryptCredential, decryptCredential, maskCredential } from "@/lib/credentials";
import { revalidatePath } from "next/cache";

export async function getCredentials(search?: string, page = 1, limit = 100) {
  const offset = (page - 1) * limit;
  const where = search ? ilike(credentials.key, `%${search}%`) : undefined;

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

  const result = [];
  for (const cred of creds) {
    const readerIds = (cred.readerUserIds as string[]) ?? [];
    const writerIds = (cred.writerUserIds as string[]) ?? [];
    const accessCount = readerIds.length + writerIds.length;

    const [owner] = await db
      .select({ displayName: userProfiles.displayName })
      .from(userProfiles)
      .where(eq(userProfiles.slackUserId, cred.ownerUserId));

    result.push({
      id: cred.id,
      key: cred.key,
      authScheme: cred.authScheme,
      ownerUserId: cred.ownerUserId,
      expiresAt: cred.expiresAt,
      createdAt: cred.createdAt,
      accessCount,
      ownerName: owner?.displayName || cred.ownerUserId,
    });
  }

  return { items: result, total };
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
  const allUserIds = [...readerIds, ...writerIds];

  const userNames: Record<string, string> = {};
  if (allUserIds.length > 0) {
    const users = await db
      .select({ slackUserId: userProfiles.slackUserId, displayName: userProfiles.displayName })
      .from(userProfiles)
      .where(sql`${userProfiles.slackUserId} = ANY(${allUserIds})`);
    
    for (const user of users) {
      userNames[user.slackUserId] = user.displayName ?? user.slackUserId;
    }
  }

  const access = [
    ...readerIds.map(userId => ({ userId, permission: 'read' as const })),
    ...writerIds.map(userId => ({ userId, permission: 'write' as const })),
  ];

  const auditLog = await db
    .select()
    .from(credentialAuditLog)
    .where(eq(credentialAuditLog.credentialId, id))
    .orderBy(desc(credentialAuditLog.timestamp))
    .limit(50);

  const [owner] = await db
    .select({ displayName: userProfiles.displayName })
    .from(userProfiles)
    .where(eq(userProfiles.slackUserId, cred.ownerUserId));

  return {
    ...cred,
    maskedValue,
    ownerName: owner?.displayName || cred.ownerUserId,
    access,
    userNames,
    auditLog,
  };
}

export async function createCredential(data: {
  key: string;
  authScheme: string;
  ownerUserId: string;
  value: string;
  expiresAt?: string;
}) {
  const encrypted = encryptCredential(data.value);
  const [cred] = await db
    .insert(credentials)
    .values({
      key: data.key,
      authScheme: data.authScheme,
      ownerUserId: data.ownerUserId,
      value: encrypted,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
    })
    .returning();
  revalidatePath("/credentials");
  return cred;
}

export async function updateCredentialValue(id: string, value: string) {
  const encrypted = encryptCredential(value);
  await db
    .update(credentials)
    .set({ value: encrypted, updatedAt: new Date() })
    .where(eq(credentials.id, id));
  revalidatePath(`/credentials/${id}`);
}

export async function deleteCredential(id: string) {
  await db.delete(credentials).where(eq(credentials.id, id));
  revalidatePath("/credentials");
}
