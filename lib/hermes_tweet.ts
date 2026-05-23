/**
 * Optional Hermes Tweet / Xquik read backend.
 *
 * The default xint route still uses X API v2 through lib/api.ts. This module is
 * activated only when an explicit backend env var requests it, and it returns
 * the same Tweet shape the existing formatters consume.
 */

import type { Tweet, UrlEntity } from "./api";

type JsonRecord = Record<string, unknown>;

export interface HermesTweetSearchOptions {
  maxResults?: number;
  pages?: number;
  sortOrder?: "relevancy" | "recency";
  since?: string;
  until?: string;
  fullArchive?: boolean;
  fieldLevel?: "minimal" | "standard" | "extended";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return fallback;
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return "";
}

function stripAt(username: string): string {
  return username.replace(/^@+/, "");
}

function readEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function normalizeReadBackend(value: string | undefined): string {
  return (value || "").trim().toLowerCase().replace(/_/g, "-");
}

export function readBackendEnabled(): boolean {
  const backend = normalizeReadBackend(
    readEnv("XINT_READ_BACKEND", "XINT_BACKEND", "TWITTER_BACKEND")
  );
  return backend === "hermes-tweet" || backend === "xquik";
}

export function getApiKey(): string {
  const apiKey = readEnv("XQUIK_API_KEY", "HERMES_TWEET_API_KEY");
  if (!apiKey) {
    throw new Error(
      "Hermes Tweet backend requires XQUIK_API_KEY or HERMES_TWEET_API_KEY"
    );
  }
  return apiKey;
}

export function getBaseUrl(): string {
  return (readEnv("XQUIK_BASE_URL") || "https://xquik.com").replace(/\/+$/, "");
}

export function buildHeaders(apiKey = getApiKey()): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey.startsWith("xq_")) {
    headers["x-api-key"] = apiKey;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

export function buildUrl(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): string {
  const url = new URL(`${getBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function requestJson(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<unknown> {
  const res = await fetch(buildUrl(path, params), {
    headers: buildHeaders(),
  });

  if (!res.ok) {
    const body = await res.text();
    let detail = body.slice(0, 240);
    try {
      const parsed = JSON.parse(body) as unknown;
      if (isRecord(parsed)) {
        detail = firstString(
          parsed.error,
          parsed.message,
          parsed.detail,
          parsed.title,
          detail
        );
      }
    } catch {
      // Keep the raw text preview.
    }
    throw new Error(`Hermes Tweet backend ${res.status}: ${detail}`);
  }

  return res.json();
}

function findArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];

  const directKeys = ["tweets", "items", "results", "data", "timeline", "followers"];
  for (const key of directKeys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }

  const data = value.data;
  if (isRecord(data)) {
    for (const key of directKeys) {
      const candidate = data[key];
      if (Array.isArray(candidate)) return candidate;
    }
  }

  const result = value.result;
  if (isRecord(result)) {
    for (const key of directKeys) {
      const candidate = result[key];
      if (Array.isArray(candidate)) return candidate;
    }
  }

  return [];
}

export function extractItems(value: unknown): unknown[] {
  return findArray(value);
}

function readPublicMetrics(source: JsonRecord): JsonRecord {
  const direct = source.public_metrics;
  if (isRecord(direct)) return direct;
  const metrics = source.metrics;
  if (isRecord(metrics)) return metrics;
  return {};
}

function metric(metrics: JsonRecord, ...keys: string[]): number {
  for (const key of keys) {
    const value = metrics[key];
    const normalized = numberValue(value);
    if (normalized !== 0) return normalized;
  }
  return 0;
}

function normalizeUrls(value: unknown): UrlEntity[] {
  const urls = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.urls)
      ? value.urls
      : [];

  return urls
    .map((item): UrlEntity | null => {
      if (typeof item === "string") return { url: item };
      if (!isRecord(item)) return null;
      const url = firstString(item.unwound_url, item.expanded_url, item.url);
      if (!url) return null;
      return {
        url,
        ...(typeof item.title === "string" && item.title ? { title: item.title } : {}),
        ...(typeof item.description === "string" && item.description
          ? { description: item.description }
          : {}),
        ...(typeof item.unwound_url === "string" && item.unwound_url !== url
          ? { unwound_url: item.unwound_url }
          : {}),
      };
    })
    .filter((url): url is UrlEntity => url !== null);
}

function normalizeTags(value: unknown, field: string): string[] {
  const items = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value[field])
      ? value[field]
      : [];
  return items
    .map((item) => {
      if (typeof item === "string") return item.replace(/^#|^@/, "");
      if (!isRecord(item)) return "";
      return firstString(item.username, item.tag, item.screen_name, item.name);
    })
    .filter(Boolean);
}

export function normalizeUser(value: unknown): JsonRecord {
  if (!isRecord(value)) return {};
  if (isRecord(value.user)) return value.user;
  if (isRecord(value.author)) return value.author;
  if (isRecord(value.account)) return value.account;
  if (isRecord(value.profile)) return value.profile;
  return value;
}

export function normalizeTweet(value: unknown): Tweet | null {
  if (!isRecord(value)) return null;

  const tweet = isRecord(value.tweet) ? value.tweet : value;
  const user = normalizeUser(value);
  const metrics = readPublicMetrics(tweet);

  const id = firstString(tweet.id, tweet.tweet_id, tweet.rest_id);
  if (!id) return null;

  const username = stripAt(
    firstString(tweet.username, tweet.screen_name, user.username, user.screen_name, "?")
  );
  const authorId = firstString(tweet.author_id, tweet.user_id, user.id, username);
  const text = firstString(tweet.text, tweet.full_text, tweet.content);
  const createdAt = firstString(tweet.created_at, tweet.date, tweet.timestamp, new Date(0).toISOString());
  const conversationId = firstString(tweet.conversation_id, tweet.thread_id, tweet.in_reply_to_status_id, id);
  const entities = isRecord(tweet.entities) ? tweet.entities : {};

  return {
    id,
    text,
    author_id: authorId,
    username,
    name: firstString(tweet.name, user.name, username || "?"),
    created_at: createdAt,
    conversation_id: conversationId,
    metrics: {
      likes: metric(metrics, "likes", "like_count", "favorite_count"),
      retweets: metric(metrics, "retweets", "retweet_count", "reposts"),
      replies: metric(metrics, "replies", "reply_count"),
      quotes: metric(metrics, "quotes", "quote_count"),
      impressions: metric(metrics, "impressions", "impression_count", "views"),
      bookmarks: metric(metrics, "bookmarks", "bookmark_count"),
    },
    urls: normalizeUrls(tweet.urls ?? entities.urls),
    mentions: normalizeTags(tweet.mentions ?? entities.mentions, "mentions"),
    hashtags: normalizeTags(tweet.hashtags ?? entities.hashtags, "hashtags"),
    tweet_url: firstString(
      tweet.tweet_url,
      tweet.url,
      `https://x.com/${username || "unknown"}/status/${id}`,
    ),
  };
}

function normalizeTweets(value: unknown): Tweet[] {
  return extractItems(value)
    .map(normalizeTweet)
    .filter((tweet): tweet is Tweet => tweet !== null);
}

function requestedLimit(opts: HermesTweetSearchOptions): number {
  const perPage = opts.maxResults || 100;
  const pages = opts.pages || 1;
  return Math.max(1, Math.min(perPage * pages, 100));
}

export async function search(
  query: string,
  opts: HermesTweetSearchOptions = {},
): Promise<Tweet[]> {
  const raw = await requestJson("/api/v1/x/tweets/search", {
    q: query,
    query,
    limit: requestedLimit(opts),
    sort: opts.sortOrder,
    since: opts.since,
    until: opts.until,
  });
  return normalizeTweets(raw);
}

export async function thread(tweetId: string, opts: { pages?: number } = {}): Promise<Tweet[]> {
  const raw = await requestJson(`/api/v1/x/tweets/${encodeURIComponent(tweetId)}/thread`, {
    limit: Math.max(1, Math.min((opts.pages || 2) * 50, 100)),
  });
  const tweets = normalizeTweets(raw);
  if (tweets.length > 0) return tweets;

  const root = await getTweet(tweetId);
  return root ? [root] : [];
}

export async function profile(
  username: string,
  opts: { count?: number; includeReplies?: boolean } = {},
): Promise<{ user: unknown; tweets: Tweet[] }> {
  const handle = stripAt(username);
  const [userRaw, tweetsRaw] = await Promise.all([
    requestJson(`/api/v1/x/users/${encodeURIComponent(handle)}`),
    requestJson(`/api/v1/x/users/${encodeURIComponent(handle)}/tweets`, {
      limit: Math.max(1, Math.min(opts.count || 20, 100)),
      replies: opts.includeReplies === true,
    }),
  ]);
  const userData = isRecord(userRaw) && "data" in userRaw ? userRaw.data : userRaw;
  return {
    user: normalizeUser(userData),
    tweets: normalizeTweets(tweetsRaw),
  };
}

export async function getTweet(tweetId: string): Promise<Tweet | null> {
  const raw = await requestJson(`/api/v1/x/tweets/${encodeURIComponent(tweetId)}`);
  return normalizeTweet(isRecord(raw) && "data" in raw ? raw.data : raw);
}
