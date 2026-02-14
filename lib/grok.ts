/**
 * lib/grok.ts — xAI Grok integration for tweet/topic analysis
 *
 * Thin wrapper around xAI's OpenAI-compatible chat completions API.
 * Provides tweet analysis, trend summarization, and general queries.
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { Tweet } from "./api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GrokMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GrokOpts {
  model?: string;        // default "grok-3-mini"
  temperature?: number;  // default 0.7
  maxTokens?: number;    // default 1024
}

export interface GrokResponse {
  content: string;
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface XaiApiError {
  error?: { message?: string; type?: string; code?: string };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const XAI_ENDPOINT = "https://api.x.ai/v1/chat/completions";
const DEFAULT_MODEL = "grok-3-mini";
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 1024;

// Rough pricing per 1M tokens (USD)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "grok-3":      { input: 3.00, output: 15.00 },
  "grok-3-mini": { input: 0.10, output: 0.40 },
  "grok-2":      { input: 2.00, output: 10.00 },
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function getXaiKey(): string {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;

  // Try .env in project directory
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
// Core API
// ---------------------------------------------------------------------------

export async function grokChat(
  messages: GrokMessage[],
  opts: GrokOpts = {},
): Promise<GrokResponse> {
  const model = opts.model || DEFAULT_MODEL;
  const apiKey = getXaiKey();

  const res = await fetch(XAI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as XaiApiError;
    const msg = body.error?.message || res.statusText;

    if (res.status === 401) {
      throw new Error(`xAI auth failed (401): ${msg}. Check your XAI_API_KEY.`);
    }
    if (res.status === 402) {
      throw new Error(`xAI payment required (402): ${msg}. Your account may be out of credits.`);
    }
    if (res.status === 429) {
      throw new Error(`xAI rate limited (429): ${msg}. Try again in a moment.`);
    }
    throw new Error(`xAI API error (${res.status}): ${msg}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  const choice = data.choices?.[0];
  if (!choice) {
    throw new Error("xAI API returned no choices");
  }

  return {
    content: choice.message.content,
    model: data.model,
    usage: {
      prompt_tokens: data.usage.prompt_tokens,
      completion_tokens: data.usage.completion_tokens,
      total_tokens: data.usage.prompt_tokens + data.usage.completion_tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Tweet formatting
// ---------------------------------------------------------------------------

function formatTweetsForContext(tweets: Tweet[]): string {
  return tweets
    .map((t, i) => {
      const m = t.metrics;
      const stats = [
        m.likes !== undefined && `${m.likes}L`,
        m.retweets !== undefined && `${m.retweets}RT`,
        m.impressions !== undefined && `${m.impressions}I`,
      ]
        .filter(Boolean)
        .join(" ");

      return `[${i + 1}] @${t.username} (${stats}) ${t.created_at}\n${t.text}`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

const TWEET_ANALYST_SYSTEM = `You are a social media analyst specializing in X/Twitter. Provide concise, actionable insights. Use bullet points where appropriate. Focus on patterns, sentiment, and engagement signals.`;

const GENERAL_ANALYST_SYSTEM = `You are a social media analyst. Provide concise, actionable insights.`;

/**
 * Analyze an array of tweets with Grok.
 * Default prompt identifies themes, sentiment, and engagement patterns.
 */
export async function analyzeTweets(
  tweets: Tweet[],
  prompt?: string,
  opts?: GrokOpts,
): Promise<GrokResponse> {
  if (tweets.length === 0) {
    throw new Error("No tweets to analyze");
  }

  const context = formatTweetsForContext(tweets);
  const userMessage =
    prompt ||
    "Analyze these tweets. Identify key themes, sentiment, notable insights, and engagement patterns.";

  return grokChat(
    [
      { role: "system", content: TWEET_ANALYST_SYSTEM },
      {
        role: "user",
        content: `Here are ${tweets.length} tweets:\n\n${context}\n\n${userMessage}`,
      },
    ],
    opts,
  );
}

/**
 * General-purpose query — ask Grok anything with optional context.
 */
export async function analyzeQuery(
  query: string,
  context?: string,
  opts?: GrokOpts,
): Promise<GrokResponse> {
  const userContent = context
    ? `Context:\n${context}\n\nQuestion: ${query}`
    : query;

  return grokChat(
    [
      { role: "system", content: GENERAL_ANALYST_SYSTEM },
      { role: "user", content: userContent },
    ],
    opts,
  );
}

/**
 * Summarize a list of trending topics.
 */
export async function summarizeTrends(
  topics: string[],
  opts?: GrokOpts,
): Promise<GrokResponse> {
  if (topics.length === 0) {
    throw new Error("No topics to summarize");
  }

  const topicList = topics.map((t, i) => `${i + 1}. ${t}`).join("\n");

  return grokChat(
    [
      {
        role: "system",
        content:
          "You are a trend analyst. Explain why each topic is trending, identify connections between topics, and note potential implications. Be concise.",
      },
      {
        role: "user",
        content: `These topics are currently trending on X/Twitter:\n\n${topicList}\n\nExplain why each is trending and identify any connections between them.`,
      },
    ],
    opts,
  );
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

function estimateCost(
  model: string,
  usage: { prompt_tokens: number; completion_tokens: number },
): string {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING[DEFAULT_MODEL];
  const inputCost = (usage.prompt_tokens / 1_000_000) * pricing.input;
  const outputCost = (usage.completion_tokens / 1_000_000) * pricing.output;
  const total = inputCost + outputCost;

  if (total < 0.0001) return "<$0.0001";
  return `~$${total.toFixed(4)}`;
}

// ---------------------------------------------------------------------------
// CLI handler
// ---------------------------------------------------------------------------

export async function cmdAnalyze(args: string[]): Promise<void> {
  let model = DEFAULT_MODEL;
  let systemPrompt: string | undefined;
  let tweetFile: string | undefined;
  let pipeMode = false;
  const queryParts: string[] = [];

  // Parse args
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--model":
        model = args[++i];
        if (!model) {
          console.error("Error: --model requires a value (grok-3, grok-3-mini, grok-2)");
          process.exit(1);
        }
        break;
      case "--system":
        systemPrompt = args[++i];
        if (!systemPrompt) {
          console.error("Error: --system requires a prompt string");
          process.exit(1);
        }
        break;
      case "--tweets":
        tweetFile = args[++i];
        if (!tweetFile) {
          console.error("Error: --tweets requires a file path");
          process.exit(1);
        }
        break;
      case "--pipe":
        pipeMode = true;
        break;
      case "--help":
      case "-h":
        printAnalyzeHelp();
        return;
      default:
        queryParts.push(arg);
    }
    i++;
  }

  const opts: GrokOpts = { model };

  try {
    let response: GrokResponse;

    if (pipeMode) {
      // Read tweets from stdin
      const input = await readStdin();
      const tweets = parseTweetsInput(input);
      const prompt = queryParts.length > 0 ? queryParts.join(" ") : undefined;
      response = await analyzeTweets(tweets, prompt, opts);
    } else if (tweetFile) {
      // Read tweets from file
      const raw = readFileSync(tweetFile, "utf-8");
      const tweets = parseTweetsInput(raw);
      const prompt = queryParts.length > 0 ? queryParts.join(" ") : undefined;
      response = await analyzeTweets(tweets, prompt, opts);
    } else if (queryParts.length > 0) {
      // General query mode
      const query = queryParts.join(" ");
      const messages: GrokMessage[] = [
        {
          role: "system",
          content: systemPrompt || GENERAL_ANALYST_SYSTEM,
        },
        { role: "user", content: query },
      ];
      response = await grokChat(messages, opts);
    } else {
      printAnalyzeHelp();
      return;
    }

    // Format output
    printResponse(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nError: ${msg}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTweetsInput(raw: string): Tweet[] {
  try {
    const parsed = JSON.parse(raw);
    // Accept either an array or { tweets: [...] }
    const arr = Array.isArray(parsed) ? parsed : parsed.tweets;
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new Error("Expected a JSON array of tweets or { tweets: [...] }");
    }
    return arr as Tweet[];
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error("Invalid JSON input. Expected a JSON array of tweet objects.");
    }
    throw err;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  // Bun supports readable streams on stdin
  const reader = Bun.stdin.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }

  const text = Buffer.concat(chunks).toString("utf-8").trim();
  if (!text) {
    throw new Error("No input received on stdin. Pipe tweet JSON or use --tweets <file>.");
  }
  return text;
}

function printResponse(response: GrokResponse): void {
  const cost = estimateCost(response.model, response.usage);

  console.log(`\n\u{1F916} Grok Analysis (${response.model})\n`);
  console.log(response.content);
  console.log(`\n---`);
  console.log(
    `Tokens: ${response.usage.prompt_tokens} prompt + ${response.usage.completion_tokens} completion = ${response.usage.total_tokens} total`,
  );
  console.log(`Model: ${response.model} | Est. cost: ${cost}`);
}

function printAnalyzeHelp(): void {
  console.log(`
Usage: xint analyze <query>           Ask Grok a question
       xint analyze --tweets <file>   Analyze tweets from a JSON file
       xint analyze --pipe            Analyze tweets piped from stdin

Options:
  --model <name>     Model: grok-3, grok-3-mini (default), grok-2
  --system <prompt>  Custom system prompt
  --tweets <file>    Path to JSON file containing tweets
  --pipe             Read tweet JSON from stdin

Examples:
  xint analyze "What are the top AI agent frameworks right now?"
  xint analyze --tweets data/search-results.json
  xint search "AI agents" --json | xint analyze --pipe "Which tweets show product launches?"
  xint analyze --model grok-3 "Deep analysis of crypto market sentiment"
`);
}
