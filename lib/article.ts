/**
 * lib/article.ts — Full article content fetcher via xAI Responses API.
 *
 * Uses Grok's web_search tool to fetch and extract article content
 * from URLs. No scraping — uses the xAI API which can access pages
 * that plain HTTP can't (JS-rendered, some paywalled content).
 *
 * Requires XAI_API_KEY in env or .env.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { extractTweetId } from "./media";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Article {
  url: string;
  title: string;
  description: string;
  content: string;       // extracted article text
  author: string;
  published: string;     // date string
  domain: string;
  ttr: number;           // time to read in minutes
  wordCount: number;
}

interface ResponsesApiResult {
  id: string;
  output: Array<{
    type: string;
    content?: Array<{ type: string; text?: string }>;
    text?: string;
  }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function getXaiKey(): string {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;

  try {
    const envFile = readFileSync(join(import.meta.dir, "..", ".env"), "utf-8");
    const match = envFile.match(/XAI_API_KEY=["']?([^"'\n]+)/);
    if (match) return match[1];
  } catch {}

  throw new Error(
    "XAI_API_KEY not found. Set it in your environment or in .env"
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const XAI_RESPONSES_ENDPOINT = "https://api.x.ai/v1/responses";
const DEFAULT_MODEL = "grok-4";
const DEFAULT_TIMEOUT_SEC = 30;

const ARTICLE_EXTRACT_PROMPT = `Read the article at this URL and extract its content. Return a JSON object with these fields:
- title: article title
- description: 1-2 sentence summary
- content: the full article text (plain text, no HTML)
- author: author name (empty string if unknown)
- published: publication date (empty string if unknown)

Return ONLY valid JSON, no markdown fences, no explanation.`;

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

/**
 * Fetch and extract article content from a URL using xAI's web_search tool.
 */
export async function fetchArticle(
  url: string,
  opts: { model?: string; full?: boolean } = {},
): Promise<Article> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const apiKey = getXaiKey();
  const model = opts.model || DEFAULT_MODEL;
  const timeoutMs = resolveArticleTimeoutMs();
  const timeoutSec = Math.floor(timeoutMs / 1000);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("article_timeout"), timeoutMs);

  let res: Response;
  try {
    res = await fetch(XAI_RESPONSES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        tools: [
          {
            type: "web_search",
            allowed_domains: [parsed.hostname],
          },
        ],
        input: [
          {
            role: "user",
            content: `${ARTICLE_EXTRACT_PROMPT}\n\nURL: ${url}`,
          },
        ],
      }),
    });
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      throw new Error(
        `Article fetch timed out after ${timeoutSec}s for ${url}. ` +
        `Set XINT_ARTICLE_TIMEOUT_SEC (5-120) to tune this.`
      );
    }
    throw new Error(`Article fetch request failed for ${url}: ${(error as Error).message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`xAI API error (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as ResponsesApiResult;

  // Extract text from response output
  const text = extractResponseText(data);
  if (!text) {
    throw new Error(
      `No article content returned for ${url}. ` +
      `The source may be blocked/unavailable from this environment.`
    );
  }

  // Parse the JSON response from Grok
  const article = parseArticleJson(text, url, parsed.hostname);

  // Truncate content unless --full
  if (!opts.full && article.content.length > 5000) {
    article.content = article.content.slice(0, 5000).replace(/\s+\S*$/, "") + "\n\n[... truncated]";
  }

  // Compute word stats from full content (before truncation for accurate count)
  const words = article.content.replace(/\[... truncated\]$/, "").split(/\s+/).filter(Boolean).length;
  article.wordCount = words;
  article.ttr = Math.ceil(words / 238);

  return article;
}

export function resolveArticleTimeoutMs(): number {
  const raw = Number.parseInt(String(process.env.XINT_ARTICLE_TIMEOUT_SEC || DEFAULT_TIMEOUT_SEC), 10);
  if (!Number.isFinite(raw)) return DEFAULT_TIMEOUT_SEC * 1000;
  const clamped = Math.min(Math.max(raw, 5), 120);
  return clamped * 1000;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function extractResponseText(data: ResponsesApiResult): string | null {
  for (const output of data.output || []) {
    // Responses API: message type with content array
    if (output.type === "message" && output.content) {
      for (const block of output.content) {
        if (block.type === "output_text" && block.text) return block.text;
        if (block.type === "text" && block.text) return block.text;
      }
    }
    // Direct text field
    if (output.text) return output.text;
  }
  return null;
}

function parseArticleJson(raw: string, url: string, domain: string): Article {
  // Strip markdown fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  try {
    const parsed = JSON.parse(cleaned);
    return {
      url,
      title: parsed.title || domain,
      description: parsed.description || "",
      content: parsed.content || "",
      author: parsed.author || "",
      published: parsed.published || "",
      domain,
      ttr: 0,
      wordCount: 0,
    };
  } catch {
    // If Grok returned plain text instead of JSON, use it as content
    return {
      url,
      title: domain,
      description: "",
      content: cleaned,
      author: "",
      published: "",
      domain,
      ttr: 0,
      wordCount: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// X Tweet URL to Article
// ---------------------------------------------------------------------------

/**
 * Extract tweet ID from X URL and fetch the tweet to get linked articles.
 */
export async function fetchTweetForArticle(tweetUrl: string): Promise<{ tweet: any; articleUrl: string | null }> {
  const tweetId = extractTweetId(tweetUrl);
  if (!tweetId) {
    throw new Error(`Invalid X tweet URL: ${tweetUrl}`);
  }

  // Import dynamically to avoid circular dependencies
  const { getTweet } = await import("./api");
  const tweet = await getTweet(tweetId);

  if (!tweet) {
    throw new Error(`Tweet not found: ${tweetId}`);
  }

  return { tweet, articleUrl: pickArticleUrlFromTweet(tweet) };
}

function normalizeCandidateUrl(value: string | undefined): string | null {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function isXArticleUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /(^|\.)x\.com$/i.test(parsed.hostname) && parsed.pathname.startsWith("/i/article/");
  } catch {
    return false;
  }
}

function isExternalNonXUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return !/(^|\.)x\.com$/i.test(parsed.hostname) && !/(^|\.)twitter\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Pick the best article URL candidate from parsed tweet payload.
 * Priority:
 * 1) external non-X URLs
 * 2) X Article URLs (x.com/i/article/*)
 * 3) any remaining valid URL candidate
 */
export function pickArticleUrlFromTweet(tweet: any): string | null {
  const candidates: string[] = [];

  const parsedUrls = Array.isArray(tweet?.urls) ? tweet.urls : [];
  for (const urlData of parsedUrls) {
    const fromUnwound = normalizeCandidateUrl(urlData?.unwound_url);
    const fromUrl = normalizeCandidateUrl(urlData?.url);
    if (fromUnwound) candidates.push(fromUnwound);
    if (fromUrl) candidates.push(fromUrl);
  }

  const entityUrls = Array.isArray(tweet?.entities?.urls) ? tweet.entities.urls : [];
  for (const urlData of entityUrls) {
    const fromUnwound = normalizeCandidateUrl(urlData?.unwound_url);
    const fromExpanded = normalizeCandidateUrl(urlData?.expanded_url);
    const fromUrl = normalizeCandidateUrl(urlData?.url);
    if (fromUnwound) candidates.push(fromUnwound);
    if (fromExpanded) candidates.push(fromExpanded);
    if (fromUrl) candidates.push(fromUrl);
  }

  const seen = new Set<string>();
  const unique = candidates.filter((candidate) => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });

  const external = unique.find(isExternalNonXUrl);
  if (external) return external;

  const xArticle = unique.find(isXArticleUrl);
  if (xArticle) return xArticle;

  return unique[0] || null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format article for terminal display.
 */
export function formatArticle(article: Article): string {
  let out = `📰 ${article.title}\n`;
  if (article.author) out += `✍️  ${article.author}`;
  if (article.published) {
    const date = article.published.includes("T")
      ? article.published.split("T")[0]
      : article.published;
    out += out.endsWith("\n") ? "" : " · ";
    out += `${date}`;
  }
  if (article.author || article.published) out += "\n";
  out += `🔗 ${article.url}\n`;
  out += `📊 ${article.wordCount} words · ${article.ttr} min read\n`;
  if (article.description) {
    out += `\n${article.description}\n`;
  }
  out += `\n---\n\n${article.content}`;
  return out;
}

/**
 * Format article with tweet context for display.
 */
export function formatArticleWithTweet(article: Article, tweet: any): string {
  const tweetUrl = tweet.tweet_url || `https://x.com/${tweet.username}/status/${tweet.id}`;
  
  let out = `📝 Tweet: ${tweetUrl}\n`;
  out += `   ${tweet.text?.slice(0, 200)}${tweet.text?.length > 200 ? "..." : ""}\n\n`;
  out += formatArticle(article);
  
  return out;
}
