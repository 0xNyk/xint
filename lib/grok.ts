/**
 * lib/grok.ts — xAI Grok integration for tweet/topic analysis
 *
 * Thin wrapper around xAI's OpenAI-compatible chat completions API.
 * Provides tweet analysis, trend summarization, and general queries.
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { Tweet } from "./api";
import { trackCostDirect } from "./costs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GrokMessage {
  role: "system" | "user" | "assistant";
  content: string | GrokContent[];
}

export interface GrokContent {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
  };
}

export interface GrokVisionOpts extends GrokOpts {
  detail?: "low" | "high" | "auto";  // vision detail level
}

export interface GrokOpts {
  model?: string;        // default "grok-4.3"
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
const DEFAULT_MODEL = "grok-4.3";
const DEFAULT_VISION_MODEL = "grok-4.3";
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 1024;

// Pricing per 1M tokens (USD), current as of 2026-07-04 (docs.x.ai/developers/models).
// The 2026-05-15 retirement removed grok-4-1-fast*, grok-4-fast*, grok-4-0709,
// grok-code-fast-1, and grok-3* — those slugs now silently REDIRECT to
// grok-4.3, so retired aliases below carry grok-4.3 pricing (that is what
// xAI actually bills). Do not "save money" by passing a retired slug.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Current lineup
  "grok-4.3":                      { input: 1.25, output: 2.50 },   // flagship, 1M ctx, vision, default
  "grok-4.20":                     { input: 2.00, output: 6.00 },   // 2M ctx
  "grok-4.20-reasoning":           { input: 2.00, output: 6.00 },
  "grok-4.20-non-reasoning":       { input: 2.00, output: 6.00 },
  "grok-build-0.1":                { input: 1.00, output: 2.00 },   // agentic coding, 256k ctx
  // Retired 2026-05-15 — xAI redirects these to grok-4.3 and bills grok-4.3 rates
  "grok-4-1-fast":                 { input: 1.25, output: 2.50 },
  "grok-4-1-fast-reasoning":       { input: 1.25, output: 2.50 },
  "grok-4-1-fast-non-reasoning":   { input: 1.25, output: 2.50 },
  "grok-4":                        { input: 1.25, output: 2.50 },
  "grok-4.20-beta":                { input: 2.00, output: 6.00 },
  "grok-code-fast-1":              { input: 1.25, output: 2.50 },
  "grok-3":                        { input: 1.25, output: 2.50 },
  "grok-3-mini":                   { input: 1.25, output: 2.50 },
  "grok-2":                        { input: 1.25, output: 2.50 },
  "grok-2-vision":                 { input: 1.25, output: 2.50 },
};

// Budget tiers — agent-friendly routing.
// Post-May-15 lineup: grok-4.3 ($1.25/$2.50) is both the cheapest and the
// default; the old $0.20 fast tier no longer exists. Free console.x.ai
// credits ($25 signup + $150/mo data-share) still apply.
type Budget = "cheap" | "balanced" | "max";
const BUDGET_MODELS: Record<Budget, string> = {
  cheap:    "grok-4.3",
  balanced: "grok-4.20",
  max:      "grok-4.20-reasoning",
};

export function resolveModel(budget?: Budget, hasImage?: boolean): string {
  if (hasImage) return DEFAULT_VISION_MODEL;
  if (budget) return BUDGET_MODELS[budget];
  return DEFAULT_MODEL;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function tryReadXaiKey(): string | undefined {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
  try {
    const envFile = readFileSync(join(import.meta.dir, "..", ".env"), "utf-8");
    const match = envFile.match(/XAI_API_KEY=["']?([^"'\n]+)/);
    if (match) return match[1];
  } catch {}
  return undefined;
}

function getXaiKey(): string {
  const key = tryReadXaiKey();
  if (key) return key;
  throw new Error("XAI_API_KEY not found. Run `xint credits --setup` for setup guidance.");
}

/**
 * Print the Grok credit onboarding guide.
 *
 * This is deliberately truthful about X Premium vs API credits — X Premium
 * unlocks the Grok *chatbot* on x.com, not API access. The free console.x.ai
 * tier ($25 signup + $150/mo data-share) is the actual programmatic lever
 * available to any developer.
 *
 * Premium-aware preface: when `premiumStatus` is provided (from OAuth's
 * /2/users/me subscription_type), we acknowledge it rather than ignore it.
 */
export function isPremium(status?: string): boolean {
  return status === "Premium" || status === "PremiumPlus" || status === "Premium+";
}

export function printCreditGuide(premiumStatus?: string): void {
  if (isPremium(premiumStatus)) {
    console.log(`\nWe see you have X ${premiumStatus}. That gives you the Grok chatbot on x.com — separate from the API.`);
    console.log(`To use Grok from xint/your agent, you still need a console.x.ai key. Here's why and how:\n`);
  }

  console.log(`Grok API credits — how to get yours free`);
  console.log(``);
  console.log(`  ✗ X Premium ($8/mo) / Premium+ ($40/mo) do NOT include API credits.`);
  console.log(`    They unlock the Grok chatbot on x.com — a separate product.`);
  console.log(`    No OAuth path from x.com to the API exists.`);
  console.log(``);
  console.log(`  ✓ Free $175/month at console.x.ai (any account, no Premium needed):`);
  console.log(`    1. Sign up at https://console.x.ai`);
  console.log(`    2. Generate an API key`);
  console.log(`    3. Opt into "data sharing" for the $150/mo bonus`);
  console.log(`       ⚠ This means xAI may train models on your prompts.`);
  console.log(`         Skip if you handle sensitive data — you'll still get $25/mo.`);
  console.log(`    4. export XAI_API_KEY=xai-...`);
  console.log(``);
  console.log(`xint routes your agent to the cheapest sufficient model by default`);
  console.log(`(grok-4.3 — $1.25/$2.50 per M tokens). Run \`xint credits\``);
  console.log(`anytime to see your burn rate.`);
  console.log(``);

  // Premium-routing tip: for one-shot human questions, the chatbot on grok.com
  // spends bundled allowance instead of API credits. Skip this for non-Premium
  // since the suggestion would be useless to them.
  if (isPremium(premiumStatus)) {
    console.log(`\u{1F4A1} Tip for Premium users: one-shot questions like "what's trending?"`);
    console.log(`   can be pasted into https://grok.com instead — that spends your Premium`);
    console.log(`   chat allowance, not API credits. xint is for the cases where you need`);
    console.log(`   automation, piping, or agent workflows.`);
    console.log(``);
  }
}

/**
 * Suggest grok.com for one-shot human queries to spend Premium UI allowance
 * instead of API credits. Returns the suggestion line, or `undefined` if the
 * heuristic says "no — this query is actually agent/automation territory".
 *
 * Skipped when:
 *   - user is not Premium (suggestion would be useless)
 *   - input is piped, file-loaded, or image-bearing (can't paste into a chatbot)
 *   - query is empty (analyze help will print instead)
 */
export function premiumChatRoutingTip(
  premiumStatus: string | undefined,
  ctx: { pipeMode: boolean; tweetFile?: string; imageUrl?: string; query?: string },
): string | undefined {
  if (!isPremium(premiumStatus)) return undefined;
  if (ctx.pipeMode || ctx.tweetFile || ctx.imageUrl) return undefined;
  if (!ctx.query || ctx.query.length === 0) return undefined;
  // The whole point is preserving API credits, so emit *before* the call —
  // caller decides where to render it.
  return (
    `\u{1F4A1} Premium tip: you can paste this question into https://grok.com to ` +
    `spend your X ${premiumStatus} chat allowance instead of API credits. ` +
    `Useful for one-shot questions; xint is best for piped, file-based, or agent flows.`
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
      throw new Error(
        `xAI payment required (402): ${msg}. Your free tier may be exhausted — ` +
        `run \`xint credits\` to see your burn rate, or top up at https://console.x.ai`
      );
    }
    if (res.status === 429) {
      throw new Error(`xAI rate limited (429): ${msg}. Try again in a moment.`);
    }
    throw new Error(`xAI API error (${res.status}): ${msg}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    model: string;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      cost_in_usd_ticks?: number;  // xAI 2026-Q2 addition: authoritative cost (µUSD)
    };
  };

  const choice = data.choices?.[0];
  if (!choice) {
    throw new Error("xAI API returned no choices");
  }

  const usage = {
    prompt_tokens: data.usage.prompt_tokens,
    completion_tokens: data.usage.completion_tokens,
    total_tokens: data.usage.prompt_tokens + data.usage.completion_tokens,
  };

  // Prefer authoritative cost from xAI when present; fall back to local estimate.
  const costUsd = costFromResponse(data.usage.cost_in_usd_ticks, model, usage);
  trackCostDirect("grok_chat", XAI_ENDPOINT, costUsd);

  return {
    content: choice.message.content,
    model: data.model,
    usage,
  };
}

/**
 * Resolve the true USD cost of a Grok call.
 * xAI returns `cost_in_usd_ticks` (micro-dollars) on newer keys; older keys
 * omit it, so we fall back to our local pricing table.
 */
function costFromResponse(
  ticks: number | undefined,
  model: string,
  usage: { prompt_tokens: number; completion_tokens: number },
): number {
  if (typeof ticks === "number" && ticks >= 0) {
    return ticks / 1_000_000;  // µUSD → USD
  }
  const pricing = MODEL_PRICING[model] || MODEL_PRICING[DEFAULT_MODEL];
  return (
    (usage.prompt_tokens / 1_000_000) * pricing.input +
    (usage.completion_tokens / 1_000_000) * pricing.output
  );
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

/**
 * Analyze an image using Grok Vision.
 * Accepts image URL or base64-encoded image data.
 */
export async function analyzeImage(
  imageUrl: string,
  question?: string,
  opts?: GrokVisionOpts,
): Promise<GrokResponse> {
  const model = opts?.model || DEFAULT_VISION_MODEL;  // grok-4.3 is vision-capable; grok-2-vision retired 2026-05-15
  const apiKey = getXaiKey();

  const defaultQuestion = question || "Describe this image in detail. What do you see?";
  
  const messages: GrokMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: defaultQuestion },
        { type: "image_url", image_url: { url: imageUrl } }
      ]
    }
  ];

  const res = await fetch(XAI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts?.temperature ?? DEFAULT_TEMPERATURE,
      max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as XaiApiError;
    const msg = body.error?.message || res.statusText;

    if (res.status === 401) {
      throw new Error(`xAI auth failed (401): ${msg}. Check your XAI_API_KEY.`);
    }
    if (res.status === 402) {
      throw new Error(
        `xAI payment required (402): ${msg}. Your free tier may be exhausted — ` +
        `run \`xint credits\` to see your burn rate, or top up at https://console.x.ai`
      );
    }
    if (res.status === 429) {
      throw new Error(`xAI rate limited (429): ${msg}. Try again in a moment.`);
    }
    if (res.status === 400 && msg.includes("vision")) {
      throw new Error(`xAI vision error (400): ${msg}. Make sure you're using a vision-capable model (grok-4.3 or grok-4.20).`);
    }
    throw new Error(`xAI API error (${res.status}): ${msg}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    model: string;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      cost_in_usd_ticks?: number;
    };
  };

  const choice = data.choices?.[0];
  if (!choice) {
    throw new Error("xAI API returned no choices");
  }

  const visionUsage = {
    prompt_tokens: data.usage.prompt_tokens,
    completion_tokens: data.usage.completion_tokens,
    total_tokens: data.usage.prompt_tokens + data.usage.completion_tokens,
  };

  const visionCostUsd = costFromResponse(data.usage.cost_in_usd_ticks, model, visionUsage);
  trackCostDirect("grok_vision", XAI_ENDPOINT, visionCostUsd);

  return {
    content: choice.message.content,
    model: data.model,
    usage: visionUsage,
  };
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
  let explicitModel: string | undefined;
  let budget: Budget | undefined;
  let tweetFile: string | undefined;
  let pipeMode = false;
  let imageUrl: string | undefined;
  const queryParts: string[] = [];

  // Parse args
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--budget":
        const b = args[++i];
        if (b !== "cheap" && b !== "balanced" && b !== "max") {
          console.error(`Error: --budget must be cheap | balanced | max (got ${b ?? "nothing"})`);
          process.exit(1);
        }
        budget = b;
        break;
      case "--model":
        explicitModel = args[++i];
        if (!explicitModel) {
          console.error("Error: --model requires a value (grok-4.3, grok-4.20, grok-4.20-reasoning, grok-build-0.1)");
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
      case "--image":
      case "-i":
        imageUrl = args[++i];
        if (!imageUrl) {
          console.error("Error: --image requires an image URL or path");
          process.exit(1);
        }
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

  // Pre-flight: if no key, print the credit guide and exit 0 so agents can
  // read it programmatically without treating it as a hard error.
  // Premium status comes from XINT_X_PREMIUM env var (user-set, no API cost).
  const premiumStatus = process.env.XINT_X_PREMIUM;
  if (!tryReadXaiKey()) {
    printCreditGuide(premiumStatus);
    return;
  }

  // Premium-routing tip: for one-shot questions, the chatbot at grok.com
  // spends Premium UI allowance — useful for humans, useless for agents.
  // Opt-in via XINT_PREMIUM_TIPS=1 so we don't add noise by default.
  if (process.env.XINT_PREMIUM_TIPS === "1") {
    const tip = premiumChatRoutingTip(premiumStatus, {
      pipeMode,
      tweetFile,
      imageUrl,
      query: queryParts.join(" "),
    });
    if (tip) console.error(tip + "\n");
  }

  // Explicit --model wins; otherwise budget → model; otherwise DEFAULT_MODEL.
  const model = explicitModel ?? resolveModel(budget, !!imageUrl);
  const opts: GrokOpts = { model };

  try {
    let response: GrokResponse;

    // Image analysis mode
    if (imageUrl) {
      const question = queryParts.length > 0 ? queryParts.join(" ") : undefined;
      // Image analysis: grok-4.3 is the current vision-capable default.
      // Legacy aliases still accepted but auto-redirect post-2026-05-15.
      const VISION_CAPABLE = new Set(["grok-4.3", "grok-4.20", "grok-4.20-reasoning", "grok-4.20-non-reasoning"]);
      const visionModel = VISION_CAPABLE.has(model) ? model : DEFAULT_VISION_MODEL;
      const visionOpts: GrokVisionOpts = { model: visionModel };
      response = await analyzeImage(imageUrl, question, visionOpts);
      printResponse(response);
      return;
    }

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
          content: GENERAL_ANALYST_SYSTEM,
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
       xint analyze --image <url>     Analyze an image with Grok Vision

Options:
  --budget <tier>    cheap (default, grok-4.3) | balanced (grok-4.20) | max (grok-4.20-reasoning)
  --model <name>     Override budget; explicit model name (grok-4.3, grok-4.20, ...)
  --tweets <file>    Path to JSON file containing tweets
  --pipe             Read tweet JSON from stdin
  --image, -i <url>  Image URL to analyze with Grok Vision (auto-uses grok-4.3)

Examples:
  xint analyze "What are the top AI agent frameworks right now?"
  xint analyze --tweets data/search-results.json
  xint search "AI agents" --json | xint analyze --pipe "Which tweets show product launches?"
  xint analyze --model grok-4.20-reasoning "Deep analysis of crypto market sentiment"
  xint analyze --image "https://example.com/chart.png" "What does this chart show?"
`);
}
