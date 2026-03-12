"use server";

import { db } from "@/lib/db";
import { memories, userProfiles } from "@schema";
import { eq, desc, sql, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";

const memoryCols = {
  id: memories.id,
  content: memories.content,
  type: memories.type,
  sourceMessageId: memories.sourceMessageId,
  sourceChannelType: memories.sourceChannelType,
  relatedUserIds: memories.relatedUserIds,
  embedding: memories.embedding,
  relevanceScore: memories.relevanceScore,
  shareable: memories.shareable,
  createdAt: memories.createdAt,
  updatedAt: memories.updatedAt,
};

async function hybridSearch(search: string, limit: number) {
  const apiUrl = process.env.AURA_API_URL;
  const apiSecret = process.env.DASHBOARD_API_SECRET;
  if (!apiUrl || !apiSecret) return null;

  try {
    const res = await fetch(`${apiUrl}/api/memories/search?q=${encodeURIComponent(search)}&limit=${limit}`, {
      headers: { Authorization: `Bearer ${apiSecret}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.memories)) return null;
    return data.memories as Array<{
      id: string;
      content: string;
      type: "fact" | "decision" | "personal" | "relationship" | "sentiment" | "open_thread";
      sourceChannelType: "dm" | "public_channel" | "private_channel";
      relevanceScore: number;
      shareable: number;
      createdAt: string;
      updatedAt: string;
      relatedUserIds: string[];
    }>;
  } catch {
    return null;
  }
}

export async function getMemories(search?: string, type?: string, page = 1, limit = 100) {
  const offset = (page - 1) * limit;

  // When searching, try the hybrid API first (embeddings + full-text + reranking)
  if (search) {
    const hybridResults = await hybridSearch(search, limit);
    if (hybridResults && hybridResults.length > 0) {
      let filtered = hybridResults;
      if (type) filtered = filtered.filter((m) => m.type === type);

      const total = filtered.length;
      const paged = filtered.slice(offset, offset + limit);

      return {
        items: paged.map((m) => ({
          ...m,
          sourceMessageId: null,
          embedding: null,
          createdAt: new Date(m.createdAt),
          updatedAt: new Date(m.updatedAt),
        })),
        total,
      };
    }
    // Fall through to full-text search if hybrid API is unavailable
  }

  const conditions = [];
  if (type) conditions.push(eq(memories.type, type as any));
  if (search) conditions.push(sql`to_tsvector('english', coalesce(${memories.content}, '')) @@ plainto_tsquery('english', ${search})`);

  const where = conditions.length ? sql`${sql.join(conditions, sql` AND `)}` : undefined;

  const [{ value: total }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(memories)
    .where(where);

  const items = await db
    .select(memoryCols)
    .from(memories)
    .where(where)
    .orderBy(desc(memories.createdAt))
    .limit(limit)
    .offset(offset);

  return { items, total };
}

export async function searchMemoriesKeyword(query: string) {
  return db
    .select(memoryCols)
    .from(memories)
    .where(sql`to_tsvector('english', coalesce(${memories.content}, '')) @@ plainto_tsquery('english', ${query})`)
    .orderBy(desc(memories.relevanceScore))
    .limit(50);
}

export async function getMemory(id: string) {
  const [memory] = await db.select(memoryCols).from(memories).where(eq(memories.id, id));
  if (!memory) return null;

  let relatedUsers: { slackUserId: string; displayName: string }[] = [];
  if (memory.relatedUserIds.length > 0) {
    relatedUsers = await db
      .select({ slackUserId: userProfiles.slackUserId, displayName: userProfiles.displayName })
      .from(userProfiles)
      .where(inArray(userProfiles.slackUserId, memory.relatedUserIds));
  }

  return { ...memory, relatedUsers };
}

export async function updateMemory(
  id: string,
  data: { content?: string; relevanceScore?: number; shareable?: number },
) {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");
  
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (data.content !== undefined) values.content = data.content;
  if (data.relevanceScore !== undefined) values.relevanceScore = data.relevanceScore;
  if (data.shareable !== undefined) values.shareable = data.shareable;

  await db.update(memories).set(values).where(eq(memories.id, id));
  revalidatePath("/memories");
  revalidatePath(`/memories/${id}`);
}

export async function deleteMemory(id: string) {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");
  
  await db.delete(memories).where(eq(memories.id, id));
  revalidatePath("/memories");
}
