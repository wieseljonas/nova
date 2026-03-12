import { db } from "@/lib/db";
import { conversationMessages, conversationParts } from "@schema";
import { eq, asc, sql } from "drizzle-orm";

export async function fetchConversationWithParts(conversationId: string) {
  const msgs = await db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId))
    .orderBy(asc(conversationMessages.orderIndex));

  const msgIds = msgs.map((m) => m.id);
  let parts: (typeof conversationParts.$inferSelect)[] = [];
  if (msgIds.length > 0) {
    parts = await db
      .select()
      .from(conversationParts)
      .where(sql`${conversationParts.messageId} IN ${msgIds}`)
      .orderBy(asc(conversationParts.orderIndex));
  }

  return msgs.map((msg) => ({
    ...msg,
    parts: parts.filter((p) => p.messageId === msg.id),
  }));
}
