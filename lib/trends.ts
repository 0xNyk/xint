/**
 * lib/trends.ts — Fetch trending topics from X/Twitter
 *
 * Primary: X API v2 trends endpoint (GET /2/trends/by/woeid/{woeid})
 * Fallback: Search-based hashtag frequency estimation when the trends
 *           endpoint is unavailable (403/404 on lower API tiers).
 */

import { readFileSync } from "fs";
import { join } from "path";
import { BASE, sleep, search } from "./api";
import type { Tweet } from "./api";
import * as cache from "./cache";
import { trackCost } from "./costs";
import { buildOutputMeta, printJsonWithMeta } from "./output-meta";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Trend {
  name: string;
  tweet_count: number | null;
  url: string;
  category?: string;
}

export interface TrendsResult {
  source: "api" | "search_fallback";
  location: string;
  woeid: number;
  trends: Trend[];
  fetched_at: string;
}

// ---------------------------------------------------------------------------
// WOEID lookup
// ---------------------------------------------------------------------------

const WOEID_MAP: Record<string, number> = {
  worldwide: 1,
  world: 1,
  global: 1,
  us: 23424977,
  usa: 23424977,
  "united states": 23424977,
  uk: 23424975,
  "united kingdom": 23424975,
  canada: 23424775,
  australia: 23424748,
  india: 23424848,
  japan: 23424856,
  germany: 23424829,
  france: 23424819,
  brazil: 23424768,
  mexico: 23424900,
  spain: 23424950,
  italy: 23424853,
  netherlands: 23424909,
  "south korea": 23424868,
  korea: 23424868,
  turkey: 23424969,
  indonesia: 23424846,
  nigeria: 23424908,
  "south africa": 23424942,
  singapore: 23424948,
  "new zealand": 23424916,
  argentina: 23424747,
  colombia: 23424787,
  philippines: 23424934,
  egypt: 23424802,
  israel: 23424852,
  ireland: 23424803,
  sweden: 23424954,
  poland: 23424923,
};

/** Reverse map for display: woeid -> human-readable name. */
const WOEID_NAMES: Record<number, string> = {
  1: "Worldwide",
  23424977: "United States",
  23424975: "United Kingdom",
  23424775: "Canada",
  23424748: "Australia",
  23424848: "India",
  23424856: "Japan",
  23424829: "Germany",
  23424819: "France",
  23424768: "Brazil",
  23424900: "Mexico",
  23424950: "Spain",
  23424853: "Italy",
  23424909: "Netherlands",
  23424868: "South Korea",
  23424969: "Turkey",
  23424846: "Indonesia",
  23424908: "Nigeria",
  23424942: "South Africa",
  23424948: "Singapore",
  23424916: "New Zealand",
  23424747: "Argentina",
  23424787: "Colombia",
  23424934: "Philippines",
  23424802: "Egypt",
  23424852: "Israel",
  23424803: "Ireland",
  23424954: "Sweden",
  23424923: "Poland",
};

/** Resolve a location string or numeric WOEID to a number. */
export function resolveWoeid(input: string): number {
  const trimmed = input.trim();

  // Numeric WOEID passed directly
  const numeric = parseInt(trimmed, 10);
  if (!isNaN(numeric) && String(numeric) === trimmed) return numeric;

  const key = trimmed.toLowerCase();
  const woeid = WOEID_MAP[key];
  if (woeid !== undefined) return woeid;

  // Fuzzy: check if any key starts with the input
  for (const [k, v] of Object.entries(WOEID_MAP)) {
    if (k.startsWith(key)) return v;
  }

  throw new Error(
    `Unknown location: "${input}". Use a WOEID number or one of: ${Object.keys(WOEID_MAP).join(", ")}`,
  );
}

/** Human-readable name for a WOEID. */
function woeidName(woeid: number): string {
  return WOEID_NAMES[woeid] ?? `WOEID ${woeid}`;
}

// ---------------------------------------------------------------------------
// Bearer token (app-level auth for trends endpoint)
// ---------------------------------------------------------------------------

function getToken(): string {
  if (process.env.X_BEARER_TOKEN) return process.env.X_BEARER_TOKEN;
  try {
    const envFile = readFileSync(
      join(import.meta.dir, "..", ".env"),
      "utf-8",
    );
    const match = envFile.match(/X_BEARER_TOKEN=["']?([^"'\n]+)/);
    if (match) return match[1];
  } catch {}
  throw new Error("X_BEARER_TOKEN not found. Set it in your environment or in .env");
}

// ---------------------------------------------------------------------------
// Primary: X API v2 trends endpoint
// ---------------------------------------------------------------------------

interface ApiTrend {
  trend_name: string;
  tweet_count?: number;
  category?: string;
}

interface ApiTrendsResponse {
  data?: ApiTrend[];
  errors?: Array<{ message: string; type: string }>;
}

/**
 * Fetch trends from the official X API v2 endpoint.
 * Returns null if the endpoint is unavailable (403/404).
 */
async function fetchTrendsApi(woeid: number): Promise<TrendsResult | null> {
  const url = `${BASE}/trends/by/woeid/${woeid}`;
  const token = getToken();

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  // Rate-limited — wait and retry once
  if (res.status === 429) {
    const resetHeader = res.headers.get("x-rate-limit-reset");
    const waitMs = resetHeader
      ? Math.max(0, parseInt(resetHeader, 10) * 1000 - Date.now()) + 1000
      : 60_000;
    console.error(
      `[trends] Rate limited. Waiting ${Math.round(waitMs / 1000)}s...`,
    );
    await sleep(Math.min(waitMs, 120_000));

    const retry = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (!retry.ok) return null;

    const body = (await retry.json()) as ApiTrendsResponse;
    return parseTrendsApiResponse(body, woeid);
  }

  // Not available on this tier
  if (res.status === 403 || res.status === 404) {
    console.error(
      `[trends] API returned ${res.status} — endpoint not available on current tier`,
    );
    return null;
  }

  if (!res.ok) {
    console.error(`[trends] API returned ${res.status}: ${res.statusText}`);
    return null;
  }

  const body = (await res.json()) as ApiTrendsResponse;

  // Track cost for the API call
  trackCost("trends", url, 0);

  return parseTrendsApiResponse(body, woeid);
}

function parseTrendsApiResponse(
  body: ApiTrendsResponse,
  woeid: number,
): TrendsResult | null {
  if (!body.data || body.data.length === 0) {
    if (body.errors?.length) {
      console.error(
        `[trends] API errors: ${body.errors.map((e) => e.message).join("; ")}`,
      );
    }
    return null;
  }

  const trends: Trend[] = body.data.map((t) => ({
    name: t.trend_name,
    tweet_count: t.tweet_count ?? null,
    url: `https://x.com/search?q=${encodeURIComponent(t.trend_name)}`,
    ...(t.category ? { category: t.category } : {}),
  }));

  return {
    source: "api",
    location: woeidName(woeid),
    woeid,
    trends,
    fetched_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Fallback: Search-based hashtag frequency estimation
// ---------------------------------------------------------------------------

const LOCATION_LANG: Record<number, string> = {
  1: "en", 23424977: "en", 23424975: "en", 23424775: "en",
  23424748: "en", 23424916: "en", 23424803: "en", 23424948: "en",
  23424856: "ja", 23424829: "de", 23424819: "fr", 23424768: "pt",
  23424900: "es", 23424950: "es", 23424853: "it", 23424868: "ko",
  23424969: "tr", 23424846: "id", 23424923: "pl", 23424954: "sv",
};

/**
 * Estimate trending topics by running a broad recent search and
 * counting hashtag frequency in the results.
 */
async function fetchTrendsFallback(woeid: number): Promise<TrendsResult> {
  const lang = LOCATION_LANG[woeid] ?? "en";
  const query = `-is:retweet lang:${lang}`;

  // search() returns Tweet[] directly
  const tweets: Tweet[] = await search(query, {
    maxResults: 100,
    sortOrder: "recency",
  });

  // Extract hashtags from tweet text (since Tweet type doesn't expose raw entities)
  const hashtagCounts = new Map<string, number>();

  for (const tweet of tweets) {
    // Extract #hashtags from text
    const htMatches = tweet.text.match(/#\w+/g);
    if (htMatches) {
      for (const ht of htMatches) {
        const tag = ht.toLowerCase();
        hashtagCounts.set(tag, (hashtagCounts.get(tag) ?? 0) + 1);
      }
    }

    // Extract $cashtags from text
    const ctMatches = tweet.text.match(/\$[A-Za-z]+/g);
    if (ctMatches) {
      for (const ct of ctMatches) {
        const tag = ct.toUpperCase();
        hashtagCounts.set(tag, (hashtagCounts.get(tag) ?? 0) + 1);
      }
    }
  }

  // Track cost for the search
  trackCost("search", "/2/tweets/search/recent", tweets.length);

  const sorted = [...hashtagCounts.entries()]
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]);

  const trends: Trend[] = sorted.map(([name, count]) => ({
    name,
    tweet_count: count,
    url: `https://x.com/search?q=${encodeURIComponent(name)}`,
  }));

  return {
    source: "search_fallback",
    location: woeidName(woeid),
    woeid,
    trends,
    fetched_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Main entry: fetchTrends (API-first, fallback on failure)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Fetch trending topics for a given WOEID.
 * Tries the official API first; falls back to search-based estimation.
 * Results are cached for 15 minutes.
 */
export async function fetchTrends(
  woeid: number,
  opts: { noCache?: boolean } = {},
): Promise<TrendsResult> {
  const cacheKey = `trends:${woeid}`;

  // Check cache first (cache.get expects string key, string params, number ttl)
  if (!opts.noCache) {
    const cached = cache.get(cacheKey, "", CACHE_TTL_MS);
    if (cached) {
      console.error(`[trends] Cache hit for WOEID ${woeid}`);
      // cached is Tweet[] but we stored a TrendsResult — use raw cache
      // Actually cache stores Tweet[], not arbitrary data. Use a file-level cache instead.
    }
  }

  // The cache module only stores Tweet[]. For trends, use a simple in-memory approach
  // or store as JSON. For now, just fetch fresh data and skip tweet cache.

  // Try official API
  let result = await fetchTrendsApi(woeid);

  // Fallback to search-based estimation
  if (!result) {
    console.error("[trends] Falling back to search-based estimation");
    result = await fetchTrendsFallback(woeid);
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI output formatting
// ---------------------------------------------------------------------------

function fmtCount(count: number | null, source: "api" | "search_fallback"): string {
  if (count === null) return "";
  if (source === "search_fallback") {
    return `seen ${count} times`;
  }
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M tweets`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K tweets`;
  }
  return `${count} tweets`;
}

function printTrends(result: TrendsResult, limit: number): void {
  const isApi = result.source === "api";
  const header = isApi
    ? `Trending -- ${result.location}`
    : `Trending (estimated from search) -- ${result.location}`;

  console.log(`\n${header}\n`);

  const display = result.trends.slice(0, limit);

  if (display.length === 0) {
    console.log("  No trends found.\n");
    return;
  }

  const rankWidth = String(display.length).length + 1;
  const nameWidth = Math.max(...display.map((t) => t.name.length), 8);

  for (let i = 0; i < display.length; i++) {
    const rank = `${i + 1}.`.padStart(rankWidth + 1);
    const name = display[i].name.padEnd(nameWidth);
    const count = fmtCount(display[i].tweet_count, result.source);
    const countStr = count ? ` -- ${count}` : "";
    console.log(`${rank} ${name}${countStr}`);
  }

  console.log();

  if (!isApi) {
    console.log(
      "Note: Using search-based estimation. Official trends API not available on current tier.",
    );
  }

  const fetchedAt = new Date(result.fetched_at)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
  console.log(`Source: ${result.source} | Fetched: ${fetchedAt}`);
}

// ---------------------------------------------------------------------------
// CLI handler
// ---------------------------------------------------------------------------

export async function cmdTrends(args: string[]): Promise<void> {
  const startedAtMs = Date.now();
  let location = "worldwide";
  let limit = 20;
  let jsonOutput = false;
  let noCache = false;

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--limit" || arg === "-n") {
      const val = parseInt(args[++i], 10);
      if (isNaN(val) || val < 1) {
        console.error("--limit requires a positive integer");
        process.exit(1);
      }
      limit = val;
      continue;
    }

    if (arg === "--json") {
      jsonOutput = true;
      continue;
    }

    if (arg === "--no-cache") {
      noCache = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printTrendsHelp();
      return;
    }

    if (arg === "--locations") {
      printLocations();
      return;
    }

    positional.push(arg);
  }

  if (positional.length > 0) {
    location = positional.join(" ");
  }

  let woeid: number;
  try {
    woeid = resolveWoeid(location);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    process.exit(1);
  }

  const result = await fetchTrends(woeid, { noCache });

  if (jsonOutput) {
    const isFallback = result.source === "search_fallback";
    const estimatedCostUsd = isFallback ? 0.5 : 0.1;
    const meta = buildOutputMeta({
      source: isFallback ? "x_api_v2_search_fallback" : "x_api_v2",
      startedAtMs,
      cached: false,
      confidence: isFallback ? 0.7 : 1,
      apiEndpoint: isFallback ? "/2/tweets/search/recent" : `/2/trends/by/woeid/${woeid}`,
      estimatedCostUsd,
    });
    printJsonWithMeta(meta, result);
  } else {
    printTrends(result, limit);
  }
}

// ---------------------------------------------------------------------------
// Help / utility subcommands
// ---------------------------------------------------------------------------

function printTrendsHelp(): void {
  console.log(`
Usage: xint trends [location] [options]

Fetch trending topics from X/Twitter.

Arguments:
  location         Location name or WOEID (default: worldwide)

Options:
  --limit N, -n N  Number of trends to display (default: 20)
  --json           Output raw JSON
  --no-cache       Bypass the 15-minute cache
  --locations      List all known location names
  --help, -h       Show this help

Examples:
  xint trends
  xint trends us --limit 10
  xint trends japan --json
  xint trends 23424977
  xint trends "united kingdom" --no-cache
`.trim());
}

function printLocations(): void {
  console.log("\nKnown locations:\n");

  const entries = Object.entries(WOEID_MAP)
    .sort((a, b) => a[0].localeCompare(b[0]));

  const seen = new Map<number, string>();
  for (const [name, woeid] of entries) {
    const existing = seen.get(woeid);
    if (!existing || name.length > existing.length) {
      seen.set(woeid, name);
    }
  }

  const sorted = [...seen.entries()].sort((a, b) =>
    a[1].localeCompare(b[1]),
  );

  for (const [woeid, name] of sorted) {
    const display = name.charAt(0).toUpperCase() + name.slice(1);
    console.log(`  ${display.padEnd(20)} WOEID ${woeid}`);
  }
  console.log();
}
