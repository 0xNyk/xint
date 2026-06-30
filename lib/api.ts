/**
 * X API wrapper — search, threads, profiles, single tweets.
 * Uses Bearer token from env: X_BEARER_TOKEN
 */

import { readFileSync } from "fs";
import { join } from "path";

export const BASE = "https://api.x.com/2";
const XQUIK_SEARCH_URL = "https://xquik.com/api/v1/x/tweets/search";
const RATE_DELAY_MS = 350; // stay under 450 req/15min

function getEnvValue(name: string): string | undefined {
  // Try env first
  if (process.env[name]) return process.env[name];

  // Try .env in project directory
  try {
    const envFile = readFileSync(
      join(import.meta.dir, "..", ".env"),
      "utf-8"
    );
    const match = envFile.match(new RegExp(`${name}=["']?([^"'\\n]+)`));
    if (match) return match[1];
  } catch {}

  return undefined;
}

function getToken(): string {
  const token = getEnvValue("X_BEARER_TOKEN");
  if (token) return token;

  throw new Error(
    "X_BEARER_TOKEN not found. Set it in your environment or in .env"
  );
}

export function getBearerToken(): string {
  return getToken();
}

function getXquikApiKey(): string {
  const apiKey = getEnvValue("XQUIK_API_KEY");
  if (apiKey) return apiKey;

  throw new Error(
    "XQUIK_API_KEY not found. Set it in your environment or in .env"
  );
}

function useXquikSearch(): boolean {
  return getEnvValue("XINT_SEARCH_PROVIDER")?.toLowerCase() === "xquik";
}

export async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export interface UrlEntity {
  url: string;          // expanded_url or unwound_url (final resolved)
  title?: string;       // page title from X API
  description?: string; // page description/summary from X API
  unwound_url?: string; // fully unwound URL (if different from expanded_url)
  images?: string[];    // preview image URLs from X API
}

export interface TweetArticle {
  title: string;
  plain_text: string;
  preview_text?: string;
  cover_media?: string;
  media_entities?: string[];
  entities?: {
    code?: Array<{
      language: string;
      code: string;
      content: string;
    }>;
  };
}

export interface Tweet {
  id: string;
  text: string;
  author_id: string;
  username: string;
  name: string;
  created_at: string;
  conversation_id: string;
  metrics: {
    likes: number;
    retweets: number;
    replies: number;
    quotes: number;
    impressions: number;
    bookmarks: number;
  };
  urls: UrlEntity[];
  mentions: string[];
  hashtags: string[];
  tweet_url: string;
  article?: TweetArticle;
  organic_metrics?: {
    impression_count: number;
    like_count: number;
    reply_count: number;
    retweet_count: number;
  };
  non_public_metrics?: {
    impression_count: number;
    url_link_clicks: number;
    user_profile_clicks: number;
  };
}

interface RawResponse {
  data?: any;
  includes?: { users?: any[] };
  meta?: { next_token?: string; result_count?: number };
  errors?: any[];
  title?: string;
  detail?: string;
  status?: number;
}

export function parseTweets(raw: RawResponse): Tweet[] {
  if (!Array.isArray(raw.data)) return [];
  const users: Record<string, any> = {};
  for (const u of raw.includes?.users || []) {
    users[u.id] = u;
  }

  return raw.data.map((t: any) => {
    const u = users[t.author_id] || {};
    const m = t.public_metrics || {};
    // Prefer note_tweet.text for extended posts (280-25K chars)
    let text = t.text;
    const noteText = t.note_tweet?.text;
    if (noteText && noteText.length > text.length) {
      text = noteText;
    }
    return {
      id: t.id,
      text,
      author_id: t.author_id,
      username: u.username || "?",
      name: u.name || "?",
      created_at: t.created_at,
      conversation_id: t.conversation_id,
      metrics: {
        likes: m.like_count || 0,
        retweets: m.retweet_count || 0,
        replies: m.reply_count || 0,
        quotes: m.quote_count || 0,
        impressions: m.impression_count || 0,
        bookmarks: m.bookmark_count || 0,
      },
      urls: (t.entities?.urls || [])
        .filter((u: any) => u.expanded_url)
        .map((u: any): UrlEntity => ({
          url: u.unwound_url || u.expanded_url,
          ...(u.title && { title: u.title }),
          ...(u.description && { description: u.description }),
          ...(u.unwound_url && u.unwound_url !== u.expanded_url && { unwound_url: u.unwound_url }),
          ...(u.images?.length > 0 && { images: u.images.map((img: any) => img.url || img).filter(Boolean) }),
        })),
      mentions: (t.entities?.mentions || [])
        .map((m: any) => m.username)
        .filter(Boolean),
      hashtags: (t.entities?.hashtags || [])
        .map((h: any) => h.tag)
        .filter(Boolean),
      tweet_url: `https://x.com/${u.username || "?"}/status/${t.id}`,
      ...(t.article?.plain_text && {
        article: {
          title: t.article.title || "",
          plain_text: t.article.plain_text,
          preview_text: t.article.preview_text || "",
          cover_media: t.article.cover_media || "",
          media_entities: t.article.media_entities || [],
          entities: t.article.entities || {},
        },
      }),
      ...(t.organic_metrics && { organic_metrics: t.organic_metrics }),
      ...(t.non_public_metrics && { non_public_metrics: t.non_public_metrics }),
    };
  });
}

// ---------------------------------------------------------------------------
// Field profiles — credit-efficiency wins (added 2026-05)
//
// X API charges per tweet read, and bigger field expansions mean larger
// response payloads (no direct cost) AND larger upstream processing
// (indirect rate-limit pressure). More importantly, several fields we used
// to always request — `article`, `note_tweet`, `entities`, `connection_status`,
// `subscription_type` — go unused by most commands. Splitting into profiles:
//
//   MINIMAL_FIELDS:  text + author + metrics + created_at. Sufficient for
//                    search, watch, trends, stream, and ~80% of analyze flows.
//   STANDARD_FIELDS: + entities + conversation_id. Needed for thread reconstruction
//                    and link extraction.
//   EXTENDED_FIELDS: + article + note_tweet + connection_status + subscription_type.
//                    Needed only when you specifically care about long-form posts,
//                    relationship status, or premium badges.
//
// `FIELDS` is now a re-export of MINIMAL_FIELDS for backward compatibility —
// existing callers automatically get the cheap default. Pass `--full-fields`
// (via fieldsFor(true)) to opt into EXTENDED_FIELDS when needed.
// ---------------------------------------------------------------------------

// MINIMAL = the "search and render a tweet card" profile. Keeps entities
// (URLs, mentions, hashtags) and conversation_id because parseTweets reads
// them on every call — dropping them silently loses display data. Drops
// article, note_tweet, connection_status, subscription_type which most
// commands never read.
//
// STANDARD = MINIMAL + connection_status. Used by `profile`, `diff` —
// commands that care about following/blocking relationships.
//
// EXTENDED = STANDARD + article + note_tweet + subscription_type. Required
// for long-form posts (note_tweet > 280 chars), article previews, and the
// Premium/verified badge. Used by `thread`, `tweet`, `report`, and any
// command that explicitly opts in with --full-fields.
// ---------------------------------------------------------------------------
// Per-process user-record cache (2026-05-16)
//
// Several flows look up the same user by username multiple times within a
// single command run: report iterates accounts then asks for tweets per
// account; followers diff resolves username → ID before fetching; engagement
// commands re-resolve before each action. Each lookup costs $0.005 and pays
// for fields we already have in memory.
//
// This LRU is process-scoped — it doesn't persist between command runs and
// doesn't need invalidation logic. Callers can pass `{ refresh: true }` to
// force a re-fetch.
// ---------------------------------------------------------------------------

interface CachedUser {
  id: string;
  username: string;
  name?: string;
  description?: string;
  public_metrics?: {
    followers_count?: number;
    following_count?: number;
    tweet_count?: number;
  };
  created_at?: string;
}

const userCache: Map<string, CachedUser> = new Map();
const USER_CACHE_MAX = 256; // capped so long-running MCP sessions don't grow unbounded

function rememberUser(u: CachedUser): void {
  // Cache by both id and lowercase username so subsequent lookups by either
  // key get a hit.
  userCache.set(u.id, u);
  userCache.set(`@${u.username.toLowerCase()}`, u);
  // Cheap LRU: when over the cap, drop oldest by insertion order.
  while (userCache.size > USER_CACHE_MAX) {
    const oldest = userCache.keys().next().value;
    if (oldest === undefined) break;
    userCache.delete(oldest);
  }
}

/**
 * Look up a user by username with per-process caching. Subsequent calls
 * within the same run return the cached record without an API call.
 *
 * Pass `refresh: true` to force a live fetch (e.g. when stale data is a
 * concern — `xint diff @user --fresh` already implies live fetches).
 */
export async function lookupUserByUsername(
  username: string,
  opts: { refresh?: boolean } = {},
): Promise<CachedUser> {
  const key = `@${username.replace(/^@/, "").toLowerCase()}`;
  if (!opts.refresh) {
    const hit = userCache.get(key);
    if (hit) return hit;
  }
  const userUrl = `${BASE}/users/by/username/${encodeURIComponent(username.replace(/^@/, ""))}?user.fields=public_metrics,description,created_at`;
  const raw = await apiGet(userUrl);
  const data = (raw as any).data;
  if (!data?.id) throw new Error(`User @${username} not found`);
  const cached: CachedUser = {
    id: data.id,
    username: data.username,
    name: data.name,
    description: data.description,
    public_metrics: data.public_metrics,
    created_at: data.created_at,
  };
  rememberUser(cached);
  return cached;
}

/** Test-only: clear the cache. Exported for unit tests; not used at runtime. */
export function _resetUserCacheForTests(): void {
  userCache.clear();
}

/** Test-only: peek at cache size. */
export function _userCacheSizeForTests(): number {
  return userCache.size;
}

export const MINIMAL_FIELDS =
  "tweet.fields=created_at,public_metrics,author_id,conversation_id,entities&expansions=author_id&user.fields=username,name,public_metrics";

export const STANDARD_FIELDS =
  "tweet.fields=created_at,public_metrics,author_id,conversation_id,entities&expansions=author_id&user.fields=username,name,public_metrics,connection_status";

export const EXTENDED_FIELDS =
  "tweet.fields=created_at,public_metrics,author_id,conversation_id,entities,article,note_tweet&expansions=author_id&user.fields=username,name,public_metrics,connection_status,subscription_type";

/** Resolve the field profile for a given command call. */
export function fieldsFor(
  level: "minimal" | "standard" | "extended" = "minimal",
): string {
  if (level === "extended") return EXTENDED_FIELDS;
  if (level === "standard") return STANDARD_FIELDS;
  return MINIMAL_FIELDS;
}

// Backwards-compatible alias. Used to be the kitchen-sink string; now defaults
// to MINIMAL_FIELDS so unchanged call sites get the cheap profile automatically.
// Commands that need extra fields must use fieldsFor("standard"|"extended").
export const FIELDS = MINIMAL_FIELDS;

/**
 * Parse a "since" value into an ISO 8601 timestamp.
 * Accepts: "1h", "2h", "6h", "12h", "1d", "2d", "3d", "7d"
 * Or a raw ISO 8601 string.
 */
export function parseSince(since: string): string | null {
  // Check for shorthand like "1h", "3h", "1d"
  const match = since.match(/^(\d+)(m|h|d)$/);
  if (match) {
    const num = parseInt(match[1]);
    const unit = match[2];
    const ms =
      unit === "m" ? num * 60_000 :
      unit === "h" ? num * 3_600_000 :
      num * 86_400_000;
    const startTime = new Date(Date.now() - ms);
    return startTime.toISOString();
  }

  // Check if it's already ISO 8601
  if (since.includes("T") || since.includes("-")) {
    try {
      return new Date(since).toISOString();
    } catch {
      return null;
    }
  }

  return null;
}

function parseDateOnly(value: string | undefined): string | null {
  if (!value) return null;

  const parsed = parseSince(value);
  if (!parsed) return null;

  return parsed.slice(0, 10);
}

function withSearchDateFilters(
  query: string,
  opts: { since?: string; until?: string },
): string {
  const parts = [query];
  const since = parseDateOnly(opts.since);
  const until = parseDateOnly(opts.until);

  if (since) parts.push(`since:${since}`);
  if (until) parts.push(`until:${until}`);

  return parts.join(" ");
}

async function apiGet(url: string): Promise<RawResponse> {
  const token = getToken();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 429) {
    const reset = res.headers.get("x-rate-limit-reset");
    const waitSec = reset
      ? Math.max(parseInt(reset) - Math.floor(Date.now() / 1000), 1)
      : 60;
    throw new Error(`Rate limited. Resets in ${waitSec}s`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X API ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * Bearer-authenticated GET request. Exposed for endpoints that don't use
 * tweet parsing helpers (for example filtered stream rules management).
 */
export async function bearerGet(url: string): Promise<any> {
  await sleep(RATE_DELAY_MS);
  return apiGet(url);
}

/**
 * Bearer-authenticated POST request.
 */
export async function bearerPost(url: string, body?: any): Promise<any> {
  await sleep(RATE_DELAY_MS);
  const token = getToken();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  const opts: RequestInit = { method: "POST", headers };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);

  if (res.status === 429) {
    const reset = res.headers.get("x-rate-limit-reset");
    const waitSec = reset
      ? Math.max(parseInt(reset) - Math.floor(Date.now() / 1000), 1)
      : 60;
    throw new Error(`Rate limited. Resets in ${waitSec}s`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X API ${res.status}: ${text.slice(0, 200)}`);
  }

  if (res.status === 204) return { success: true };
  return res.json();
}

async function xquikSearch(
  query: string,
  opts: {
    maxResults?: number;
    pages?: number;
    sortOrder?: "relevancy" | "recency";
    since?: string;
    until?: string;
  },
): Promise<Tweet[]> {
  const apiKey = getXquikApiKey();
  const maxResults = Math.max(Math.min(opts.maxResults || 100, 100), 1);
  const pages = opts.pages || 1;
  const queryType = opts.sortOrder === "recency" ? "Latest" : "Top";

  let allTweets: Tweet[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < pages; page++) {
    const url = new URL(XQUIK_SEARCH_URL);
    url.searchParams.set("q", withSearchDateFilters(query, opts));
    url.searchParams.set("queryType", queryType);
    url.searchParams.set("limit", String(maxResults));
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url, {
      headers: { "X-API-Key": apiKey },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Xquik API ${res.status}: ${body.slice(0, 200)}`);
    }

    const raw = await res.json();
    const tweets = Array.isArray(raw.tweets) ? raw.tweets : [];
    allTweets.push(...tweets.map((tweet: any): Tweet => {
      const author = tweet.author || {};
      const username = author.username || author.userName || "?";
      return {
        id: String(tweet.id || ""),
        text: String(tweet.text || ""),
        author_id: String(author.id || tweet.author_id || ""),
        username,
        name: String(author.name || username),
        created_at: String(tweet.createdAt || tweet.created_at || ""),
        conversation_id: String(tweet.conversationId || tweet.conversation_id || tweet.id || ""),
        metrics: {
          likes: Number(tweet.likeCount || tweet.likes || 0),
          retweets: Number(tweet.retweetCount || tweet.retweets || 0),
          replies: Number(tweet.replyCount || tweet.replies || 0),
          quotes: Number(tweet.quoteCount || tweet.quotes || 0),
          impressions: Number(tweet.viewCount || tweet.impressionCount || 0),
          bookmarks: Number(tweet.bookmarkCount || 0),
        },
        urls: [],
        mentions: [],
        hashtags: [],
        tweet_url: String(tweet.url || `https://x.com/${username}/status/${tweet.id}`),
      };
    }));

    cursor = raw.next_cursor;
    if (!raw.has_next_page || !cursor) break;
    if (page < pages - 1) await sleep(RATE_DELAY_MS);
  }

  return allTweets;
}

/**
 * OAuth-authenticated GET request. Uses a user access token instead of
 * the app bearer token. Needed for user-context endpoints (bookmarks).
 */
export async function oauthGet(url: string, accessToken: string): Promise<RawResponse> {
  await sleep(RATE_DELAY_MS);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) {
    throw new Error("OAuth token rejected (401). Try 'auth refresh' or re-run 'auth setup'.");
  }

  if (res.status === 403) {
    const body = await res.text();
    throw new Error(
      `X API access forbidden (403). This endpoint requires pay-per-use or Enterprise access. ` +
      `Your current X API tier may not include this endpoint. ${body.slice(0, 200)}`
    );
  }

  if (res.status === 429) {
    const reset = res.headers.get("x-rate-limit-reset");
    const waitSec = reset
      ? Math.max(parseInt(reset) - Math.floor(Date.now() / 1000), 1)
      : 60;
    throw new Error(`Rate limited. Resets in ${waitSec}s`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X API ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * Search tweets. Uses /recent (last 7 days) by default.
 * Pass fullArchive: true for /all (complete archive back to 2006,
 * requires pay-per-use or Enterprise access).
 */
export async function search(
  query: string,
  opts: {
    maxResults?: number;
    pages?: number;
    sortOrder?: "relevancy" | "recency";
    since?: string; // ISO 8601 timestamp or shorthand like "1h", "3h", "1d"
    until?: string; // ISO 8601 timestamp or shorthand (full-archive only)
    fullArchive?: boolean;
    fieldLevel?: "minimal" | "standard" | "extended"; // payload profile; default minimal
  } = {}
): Promise<Tweet[]> {
  if (useXquikSearch()) {
    if (opts.fullArchive) {
      throw new Error(
        "Xquik search provider does not support full-archive mode. Unset XINT_SEARCH_PROVIDER for full archive search."
      );
    }
    return xquikSearch(query, opts);
  }

  const isArchive = opts.fullArchive || false;
  const maxPerPage = isArchive ? 500 : 100;
  const maxResults = Math.max(Math.min(opts.maxResults || maxPerPage, maxPerPage), 10);
  const pages = opts.pages || 1;
  const sort = opts.sortOrder || "relevancy";
  const encoded = encodeURIComponent(query);
  const endpoint = isArchive ? "tweets/search/all" : "tweets/search/recent";
  const fields = fieldsFor(opts.fieldLevel);

  // Build time filters
  let timeFilter = "";
  if (opts.since) {
    const startTime = parseSince(opts.since);
    if (startTime) {
      timeFilter += `&start_time=${startTime}`;
    }
  }
  if (opts.until) {
    const endTime = parseSince(opts.until);
    if (endTime) {
      timeFilter += `&end_time=${endTime}`;
    }
  }

  let allTweets: Tweet[] = [];
  let nextToken: string | undefined;

  for (let page = 0; page < pages; page++) {
    const pagination = nextToken
      ? `&next_token=${nextToken}`
      : "";
    const url = `${BASE}/${endpoint}?query=${encoded}&max_results=${maxResults}&${fields}&sort_order=${sort}${timeFilter}${pagination}`;

    const raw = await apiGet(url);
    const tweets = parseTweets(raw);
    allTweets.push(...tweets);

    nextToken = raw.meta?.next_token;
    if (!nextToken) break;
    if (page < pages - 1) await sleep(RATE_DELAY_MS);
  }

  return allTweets;
}
/**
 * Fetch a full conversation thread by root tweet ID.
 */
export async function thread(
  conversationId: string,
  opts: { pages?: number } = {}
): Promise<Tweet[]> {
  const query = `conversation_id:${conversationId}`;
  const tweets = await search(query, {
    pages: opts.pages || 2,
    sortOrder: "recency",
  });

  // Also fetch the root tweet
  try {
    // Thread root: single tweet, opt into extended fields so we get
    // article preview + note_tweet expansion if present.
    const rootUrl = `${BASE}/tweets/${conversationId}?${EXTENDED_FIELDS}`;
    const raw = await apiGet(rootUrl);
    const rootTweets = parseTweets({ ...raw, data: raw.data ? [raw.data] : (raw as any).id ? [raw] : [] });
    // Fix: single tweet lookup returns tweet at top level
    if ((raw as any).id) {
      // raw is the tweet itself — need to re-fetch with proper structure
    }
    if (rootTweets.length > 0) {
      tweets.unshift(...rootTweets);
    }
  } catch {
    // Root tweet might be deleted
  }

  return tweets;
}

/**
 * Get recent tweets from a specific user.
 */
export async function profile(
  username: string,
  opts: { count?: number; includeReplies?: boolean } = {}
): Promise<{ user: any; tweets: Tweet[] }> {
  // Look up user via cache — saves a $0.005 call if we've seen this user
  // already in the same process (common in report / engagement flows that
  // iterate over a list of accounts).
  const user = await lookupUserByUsername(username);
  await sleep(RATE_DELAY_MS);

  // Build search query
  const replyFilter = opts.includeReplies ? "" : " -is:reply";
  const query = `from:${username} -is:retweet${replyFilter}`;
  const tweets = await search(query, {
    maxResults: Math.min(opts.count || 20, 100),
    sortOrder: "recency",
  });

  return { user, tweets };
}

/**
 * Fetch a single tweet by ID.
 */
export async function getTweet(tweetId: string): Promise<Tweet | null> {
  // Single-tweet fetch: marginal cost from the larger field set is
  // ~$0.005 vs $0.005 (same per-tweet rate; payload is the only diff),
  // so it's effectively free to ask for everything.
  const url = `${BASE}/tweets/${tweetId}?${EXTENDED_FIELDS}`;
  const raw = await apiGet(url);

  // Single tweet returns { data: {...}, includes: {...} }
  if (raw.data && !Array.isArray(raw.data)) {
    const parsed = parseTweets({ ...raw, data: [raw.data] });
    return parsed[0] || null;
  }
  return null;
}

/**
 * Sort tweets by engagement metric.
 */
export function sortBy(
  tweets: Tweet[],
  metric: "likes" | "impressions" | "retweets" | "replies" = "likes"
): Tweet[] {
  return [...tweets].sort((a, b) => b.metrics[metric] - a.metrics[metric]);
}

/**
 * Filter tweets by minimum engagement.
 */
export function filterEngagement(
  tweets: Tweet[],
  opts: { minLikes?: number; minImpressions?: number }
): Tweet[] {
  return tweets.filter((t) => {
    if (opts.minLikes && t.metrics.likes < opts.minLikes) return false;
    if (opts.minImpressions && t.metrics.impressions < opts.minImpressions)
      return false;
    return true;
  });
}

/**
 * Deduplicate tweets by ID.
 */
export function dedupe(tweets: Tweet[]): Tweet[] {
  const seen = new Set<string>();
  return tweets.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

/**
 * OAuth-authenticated POST request. Used for write operations
 * (like, bookmark, etc.) that require user context.
 */
export async function oauthPost(url: string, accessToken: string, body?: any): Promise<any> {
  await sleep(RATE_DELAY_MS);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };
  const opts: RequestInit = { method: "POST", headers };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);

  if (res.status === 401) {
    throw new Error("OAuth token rejected (401). Try 'auth refresh' or re-run 'auth setup'.");
  }
  if (res.status === 403) {
    const text = await res.text();
    throw new Error(
      `X API access forbidden (403). This endpoint requires pay-per-use or Enterprise access. ` +
      `Your current X API tier may not include this endpoint. ${text.slice(0, 200)}`
    );
  }
  if (res.status === 429) {
    const reset = res.headers.get("x-rate-limit-reset");
    const waitSec = reset
      ? Math.max(parseInt(reset) - Math.floor(Date.now() / 1000), 1)
      : 60;
    throw new Error(`Rate limited. Resets in ${waitSec}s`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X API ${res.status}: ${text.slice(0, 200)}`);
  }

  if (res.status === 204) return { success: true };
  return res.json();
}

/**
 * OAuth-authenticated PUT request. Used for update operations
 * (for example list metadata updates) that require user context.
 */
export async function oauthPut(url: string, accessToken: string, body?: any): Promise<any> {
  await sleep(RATE_DELAY_MS);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };
  const opts: RequestInit = { method: "PUT", headers };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);

  if (res.status === 401) {
    throw new Error("OAuth token rejected (401). Try 'auth refresh' or re-run 'auth setup'.");
  }
  if (res.status === 403) {
    const text = await res.text();
    throw new Error(
      `X API access forbidden (403). This endpoint requires pay-per-use or Enterprise access. ` +
      `Your current X API tier may not include this endpoint. ${text.slice(0, 200)}`
    );
  }
  if (res.status === 429) {
    const reset = res.headers.get("x-rate-limit-reset");
    const waitSec = reset
      ? Math.max(parseInt(reset) - Math.floor(Date.now() / 1000), 1)
      : 60;
    throw new Error(`Rate limited. Resets in ${waitSec}s`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X API ${res.status}: ${text.slice(0, 200)}`);
  }

  if (res.status === 204) return { success: true };
  return res.json();
}

/**
 * OAuth-authenticated DELETE request. Used for undo operations
 * (unlike, unbookmark, etc.) that require user context.
 */
export async function oauthDelete(url: string, accessToken: string): Promise<any> {
  await sleep(RATE_DELAY_MS);

  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) {
    throw new Error("OAuth token rejected (401). Try 'auth refresh' or re-run 'auth setup'.");
  }
  if (res.status === 403) {
    const text = await res.text();
    throw new Error(
      `X API access forbidden (403). This endpoint requires pay-per-use or Enterprise access. ` +
      `Your current X API tier may not include this endpoint. ${text.slice(0, 200)}`
    );
  }
  if (res.status === 429) {
    const reset = res.headers.get("x-rate-limit-reset");
    const waitSec = reset
      ? Math.max(parseInt(reset) - Math.floor(Date.now() / 1000), 1)
      : 60;
    throw new Error(`Rate limited. Resets in ${waitSec}s`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X API ${res.status}: ${text.slice(0, 200)}`);
  }

  if (res.status === 204) return { success: true };
  return res.json();
}
