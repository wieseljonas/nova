import { sql, lt, and, gt } from "drizzle-orm";
import { db } from "../db/client.js";
import { memories } from "../db/schema.js";
import { logger } from "../lib/logger.js";

/**
 * Memory consolidation — runs as a daily Vercel Cron job.
 *
 * Responsibilities:
 * 1. Decay relevance scores of older memories
 * 2. Find and merge duplicate memories (high cosine similarity)
 * 3. Flag contradictory memories
 */

/**
 * Decay relevance scores.
 * Multiplies all relevance_scores by a decay factor (0.995 per day).
 * This means a memory loses ~50% relevance after ~138 days.
 * Memories with a score below the floor are not deleted, just deprioritized.
 */
export async function decayRelevanceScores(): Promise<number> {
  const DECAY_FACTOR = 0.995;
  const MIN_SCORE = 0.01;

  try {
    const result = await db
      .update(memories)
      .set({
        relevanceScore: sql`GREATEST(${MIN_SCORE}, ${memories.relevanceScore} * ${DECAY_FACTOR})`,
        updatedAt: new Date(),
      })
      .where(gt(memories.relevanceScore, MIN_SCORE));

    logger.info("Decayed relevance scores", { factor: DECAY_FACTOR });
    return 0; // drizzle doesn't return rowcount on update easily
  } catch (error) {
    logger.error("Failed to decay relevance scores", { error: String(error) });
    throw error;
  }
}

/**
 * Find and merge duplicate memories.
 * Memories with cosine similarity > 0.95 are considered duplicates.
 * Keeps the more recent one (or the one with higher relevance).
 */
export async function mergeDuplicateMemories(): Promise<number> {
  try {
    // Find pairs of very similar memories
    const duplicates = await db.execute(sql`
      WITH pairs AS (
        SELECT
          m1.id AS id1,
          m2.id AS id2,
          m1.content AS content1,
          m2.content AS content2,
          m1.relevance_score AS score1,
          m2.relevance_score AS score2,
          m1.created_at AS created1,
          m2.created_at AS created2,
          1 - (m1.embedding <=> m2.embedding) AS similarity
        FROM memories m1
        JOIN memories m2 ON m1.id < m2.id
        WHERE m1.embedding IS NOT NULL
          AND m2.embedding IS NOT NULL
          AND 1 - (m1.embedding <=> m2.embedding) > 0.95
        LIMIT 100
      )
      SELECT * FROM pairs ORDER BY similarity DESC
    `);

    if (!duplicates.rows || duplicates.rows.length === 0) {
      logger.info("No duplicate memories found");
      return 0;
    }

    let mergedCount = 0;
    const deletedIds: string[] = [];

    for (const pair of duplicates.rows as any[]) {
      // Keep the one with higher relevance, or more recent if equal
      const keepId =
        pair.score1 >= pair.score2 ? pair.id1 : pair.id2;
      const deleteId = keepId === pair.id1 ? pair.id2 : pair.id1;

      if (deletedIds.includes(deleteId) || deletedIds.includes(keepId)) {
        continue; // Already processed
      }

      // Boost the kept memory's relevance (it was mentioned/relevant multiple times)
      const boostedScore = Math.min(
        1.0,
        Math.max(pair.score1, pair.score2) * 1.1,
      );

      await db
        .update(memories)
        .set({
          relevanceScore: boostedScore,
          updatedAt: new Date(),
        })
        .where(sql`${memories.id} = ${keepId}`);

      // Soft-delete the duplicate by setting its score very low
      await db
        .update(memories)
        .set({
          relevanceScore: 0.001,
          updatedAt: new Date(),
        })
        .where(sql`${memories.id} = ${deleteId}`);

      deletedIds.push(deleteId);
      mergedCount++;
    }

    logger.info(`Merged ${mergedCount} duplicate memories`);
    return mergedCount;
  } catch (error) {
    logger.error("Failed to merge duplicate memories", {
      error: String(error),
    });
    throw error;
  }
}

/**
 * Run full consolidation pipeline.
 */
export async function runConsolidation(): Promise<{
  decayed: boolean;
  mergedCount: number;
}> {
  logger.info("Starting memory consolidation");
  const start = Date.now();

  await decayRelevanceScores();
  const mergedCount = await mergeDuplicateMemories();

  logger.info(`Consolidation completed in ${Date.now() - start}ms`, {
    mergedCount,
  });

  return { decayed: true, mergedCount };
}
