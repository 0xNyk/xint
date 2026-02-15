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
const DEFAULT_MODEL = "grok-3-mini";

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

  const res = await fetch(XAI_RESPONSES_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
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

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`xAI API error (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as ResponsesApiResult;

  // Extract text from response output
  const text = extractResponseText(data);
  if (!text) {
    throw new Error(`No content returned for ${url}`);
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
