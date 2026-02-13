import { createOpenAI } from "@ai-sdk/openai";

/**
 * Primary LLM provider — routed through Vercel AI Gateway if configured,
 * otherwise direct to OpenAI.
 */
const baseURL = process.env.AI_GATEWAY_URL || undefined;

export const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  ...(baseURL ? { baseURL } : {}),
});

/**
 * Model references — centralised so we can swap easily.
 *
 * - `mainModel` — for conversation responses (quality matters)
 * - `fastModel` — for memory extraction, profile updates (speed/cost matters)
 * - `embeddingModel` — for embedding memories and queries
 */
export const mainModel = openai("gpt-4o");
export const fastModel = openai("gpt-4o-mini");
export const embeddingModel = openai.embedding("text-embedding-3-small");
