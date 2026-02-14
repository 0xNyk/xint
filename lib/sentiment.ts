/**
 * lib/sentiment.ts — AI-powered sentiment analysis via Grok.
 *
 * Enriches tweets with sentiment labels (positive/negative/neutral),
 * confidence scores, and aggregate statistics.
 */

import type { Tweet } from "./api";
import { grokChat, type GrokOpts } from "./grok";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SentimentResult {
  id: string;
  sentiment: "positive" | "negative" | "neutral" | "mixed";
  score: number;     // -1.0 to 1.0
  label?: string;    // short reason
}

export interface SentimentStats {
  positive: number;
  negative: number;
  neutral: number;
  mixed: number;
  average_score: number;
}

export interface EnrichedTweet extends Tweet {
  sentiment?: SentimentResult;
}

// ---------------------------------------------------------------------------
// Grok sentiment analysis
// ---------------------------------------------------------------------------

const SENTIMENT_SYSTEM = `You are a sentiment analysis engine. Given tweets, return a JSON array with sentiment analysis for each tweet.

For each tweet, provide:
- id: the tweet ID
- sentiment: one of "positive", "negative", "neutral", "mixed"
- score: a number from -1.0 (very negative) to 1.0 (very positive)
- label: a 2-5 word reason (e.g., "excited about launch", "frustrated with bugs", "neutral observation")

Detect sarcasm, irony, and context. Crypto/tech enthusiasm is positive. Complaints/frustration are negative. Questions and factual statements are neutral.

Return ONLY valid JSON array, no markdown fences, no explanation.`;

/**
 * Analyze sentiment for a batch of tweets using Grok.
 * Processes in batches of 20 to stay within token limits.
 */
export async function analyzeSentiment(
  tweets: Tweet[],
  opts?: GrokOpts,
): Promise<SentimentResult[]> {
  if (tweets.length === 0) return [];

  const batchSize = 20;
  const results: SentimentResult[] = [];

  for (let i = 0; i < tweets.length; i += batchSize) {
    const batch = tweets.slice(i, i + batchSize);
    const tweetContext = batch
      .map(t => `[${t.id}] @${t.username}: ${t.text.slice(0, 280)}`)
      .join("\n\n");

    try {
      const response = await grokChat(
        [
          { role: "system", content: SENTIMENT_SYSTEM },
          {
            role: "user",
            content: `Analyze sentiment for these ${batch.length} tweets:\n\n${tweetContext}`,
          },
        ],
        {
          model: opts?.model || "grok-3-mini",
          temperature: 0.3,  // low temperature for consistent analysis
          maxTokens: opts?.maxTokens || 2048,
        },
      );

      // Parse JSON response
      const parsed = parseJsonResponse(response.content, batch);
      results.push(...parsed);
    } catch (e: any) {
      // On failure, mark batch as neutral
      console.error(`[sentiment] Batch analysis failed: ${e.message}`);
      for (const t of batch) {
        results.push({ id: t.id, sentiment: "neutral", score: 0, label: "analysis failed" });
      }
    }
  }

  return results;
}

/**
 * Parse Grok's JSON response, with fallback handling for malformed output.
 */
function parseJsonResponse(content: string, tweets: Tweet[]): SentimentResult[] {
  // Strip markdown code fences if present
  let cleaned = content.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.map(item => ({
        id: String(item.id),
        sentiment: validateSentiment(item.sentiment),
        score: clampScore(Number(item.score) || 0),
        label: item.label || undefined,
      }));
    }
  } catch {}

  // Fallback: try to extract JSON array from response
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed.map(item => ({
          id: String(item.id),
          sentiment: validateSentiment(item.sentiment),
          score: clampScore(Number(item.score) || 0),
          label: item.label || undefined,
        }));
      }
    } catch {}
  }

  // Final fallback: return neutral for all
  return tweets.map(t => ({
    id: t.id,
    sentiment: "neutral" as const,
    score: 0,
    label: "parse failed",
  }));
}

function validateSentiment(s: any): SentimentResult["sentiment"] {
  if (["positive", "negative", "neutral", "mixed"].includes(s)) return s;
  return "neutral";
}

function clampScore(n: number): number {
  return Math.max(-1, Math.min(1, Math.round(n * 100) / 100));
}

// ---------------------------------------------------------------------------
// Enrich tweets with sentiment
// ---------------------------------------------------------------------------

/**
 * Attach sentiment results to tweets.
 */
export function enrichTweets(tweets: Tweet[], sentiments: SentimentResult[]): EnrichedTweet[] {
  const sentimentMap = new Map(sentiments.map(s => [s.id, s]));
  return tweets.map(t => ({
    ...t,
    sentiment: sentimentMap.get(t.id),
  }));
}

/**
 * Compute aggregate sentiment stats.
 */
export function computeStats(sentiments: SentimentResult[]): SentimentStats {
  const counts = { positive: 0, negative: 0, neutral: 0, mixed: 0 };
  let totalScore = 0;

  for (const s of sentiments) {
    counts[s.sentiment]++;
    totalScore += s.score;
  }

  return {
    ...counts,
    average_score: sentiments.length > 0
      ? Math.round((totalScore / sentiments.length) * 100) / 100
      : 0,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function sentimentIcon(s: SentimentResult["sentiment"]): string {
  switch (s) {
    case "positive": return "+";
    case "negative": return "-";
    case "mixed": return "~";
    default: return "=";
  }
}

function scoreBar(score: number): string {
  // Convert -1..1 to 0..10
  const normalized = Math.round((score + 1) * 5);
  const filled = Math.max(0, Math.min(10, normalized));
  return "[" + "#".repeat(filled) + ".".repeat(10 - filled) + "]";
}

/**
 * Format a sentiment-enriched tweet for terminal display.
 */
export function formatSentimentTweet(t: EnrichedTweet, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : "";
  const s = t.sentiment;
  const sentimentTag = s
    ? `(${sentimentIcon(s.sentiment)}${s.score.toFixed(1)} ${s.label || s.sentiment})`
    : "";

  const cleanText = t.text.replace(/https:\/\/t\.co\/\S+/g, "").trim();
  const truncated = cleanText.length > 180 ? cleanText.slice(0, 177) + "..." : cleanText;

  let out = `${prefix}@${t.username} ${sentimentTag}`;
  out += `\n${truncated}`;
  out += `\n${t.tweet_url}`;

  return out;
}

/**
 * Format aggregate sentiment stats.
 */
export function formatStats(stats: SentimentStats, total: number): string {
  const pct = (n: number) => total > 0 ? `${Math.round((n / total) * 100)}%` : "0%";

  let out = `\nSentiment Analysis (${total} tweets):\n`;
  out += `  Avg score: ${stats.average_score.toFixed(2)} ${scoreBar(stats.average_score)}\n`;
  out += `  + Positive: ${stats.positive} (${pct(stats.positive)})\n`;
  out += `  - Negative: ${stats.negative} (${pct(stats.negative)})\n`;
  out += `  = Neutral:  ${stats.neutral} (${pct(stats.neutral)})\n`;
  if (stats.mixed > 0) {
    out += `  ~ Mixed:    ${stats.mixed} (${pct(stats.mixed)})\n`;
  }

  return out;
}
