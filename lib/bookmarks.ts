/**
 * Bookmarks — fetch and display user bookmarks via OAuth 2.0.
 * Requires: auth setup (PKCE flow) to have been run first.
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { BASE, FIELDS, oauthGet, parseTweets, parseSince, sleep, sortBy, dedupe } from "./api";
import type { Tweet } from "./api";
import { getValidToken, loadTokens } from "./oauth";
import * as cache from "./cache";
import * as fmt from "./format";
import { trackCost } from "./costs";

const SKILL_DIR = join(import.meta.dir, "..");
const DRAFTS_DIR = join(SKILL_DIR, "data", "exports");
const BOOKMARK_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch bookmarks via GET /2/users/{id}/bookmarks with pagination.
 * Max 800 bookmarks total (API limit), 100 per page.
 */
export async function fetchBookmarks(
  userId: string,
  accessToken: string,
  maxTotal: number = 100
): Promise<Tweet[]> {
  const allTweets: Tweet[] = [];
  let nextToken: string | undefined;
  const perPage = Math.min(maxTotal, 100);
  const maxPages = Math.ceil(Math.min(maxTotal, 800) / perPage);

  for (let page = 0; page < maxPages; page++) {
    const pagination = nextToken ? `&pagination_token=${nextToken}` : "";
    const url = `${BASE}/users/${userId}/bookmarks?max_results=${perPage}&${FIELDS}${pagination}`;

    const raw = await oauthGet(url, accessToken);
    const tweets = parseTweets(raw);
    allTweets.push(...tweets);

    if (allTweets.length >= maxTotal) break;

    nextToken = (raw as any).meta?.next_token;
    if (!nextToken) break;
    if (page < maxPages - 1) await sleep(350);
  }

  return allTweets.slice(0, maxTotal);
}

/**
 * CLI handler for the bookmarks command.
 */
export async function cmdBookmarks(args: string[]): Promise<void> {
  // Parse flags
  const flags = new Set<string>();
  const opts: Record<string, string> = {};

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      // Boolean flags
      if (["json", "markdown", "save", "no-cache"].includes(name)) {
        flags.add(name);
      } else if (i + 1 < args.length) {
        opts[name] = args[++i];
      }
    } else {
      positional.push(arg);
    }
  }

  const limit = parseInt(opts.limit || "20");
  const sinceStr = opts.since;
  const queryFilter = opts.query;
  const asJson = flags.has("json");
  const asMarkdown = flags.has("markdown");
  const save = flags.has("save");
  const noCache = flags.has("no-cache");

  // Get OAuth token (auto-refresh if needed)
  const accessToken = await getValidToken();
  const tokens = loadTokens()!;

  // Check cache
  const cacheKey = `bookmarks:${tokens.user_id}`;
  const cacheParams = `limit=${limit}`;

  if (!noCache) {
    const cached = cache.get(cacheKey, cacheParams, BOOKMARK_CACHE_TTL_MS);
    if (cached) {
      console.error(`(cached — ${cached.length} bookmarks)`);
      outputBookmarks(cached, { limit, sinceStr, queryFilter, asJson, asMarkdown, save });
      return;
    }
  }

  // Fetch bookmarks — request more than limit to allow for client-side filtering
  const fetchCount = Math.min(
    sinceStr || queryFilter ? Math.max(limit * 3, 100) : limit,
    800
  );

  console.error(`Fetching bookmarks for @${tokens.username}...`);
  const tweets = await fetchBookmarks(tokens.user_id, accessToken, fetchCount);

  // Track cost
  trackCost("bookmarks", `/2/users/me/bookmarks`, tweets.length);

  if (tweets.length === 0) {
    console.log("No bookmarks found.");
    return;
  }

  // Cache raw results
  cache.set(cacheKey, cacheParams, tweets);

  outputBookmarks(tweets, { limit, sinceStr, queryFilter, asJson, asMarkdown, save });
}

function outputBookmarks(
  tweets: Tweet[],
  opts: {
    limit: number;
    sinceStr?: string;
    queryFilter?: string;
    asJson: boolean;
    asMarkdown: boolean;
    save: boolean;
  }
): void {
  let filtered = [...tweets];

  // Client-side --since filter
  if (opts.sinceStr) {
    const sinceTs = parseSince(opts.sinceStr);
    if (sinceTs) {
      const sinceMs = new Date(sinceTs).getTime();
      filtered = filtered.filter((t) => new Date(t.created_at).getTime() >= sinceMs);
    }
  }

  // Client-side --query text filter (case-insensitive substring match)
  if (opts.queryFilter) {
    const q = opts.queryFilter.toLowerCase();
    filtered = filtered.filter(
      (t) =>
        t.text.toLowerCase().includes(q) ||
        t.username.toLowerCase().includes(q) ||
        t.hashtags.some((h) => h.toLowerCase().includes(q))
    );
  }

  filtered = dedupe(filtered);
  const shown = filtered.slice(0, opts.limit);

  if (shown.length === 0) {
    console.log("No bookmarks match the filters.");
    return;
  }

  // Output
  if (opts.asJson) {
    console.log(JSON.stringify(shown, null, 2));
  } else if (opts.asMarkdown) {
    const md = fmt.formatResearchMarkdown("Bookmarks", shown, {
      queries: ["bookmarks"],
    });
    console.log(md);
  } else {
    console.log(fmt.formatResultsTelegram(shown, { query: "Bookmarks", limit: opts.limit }));
  }

  // Save
  if (opts.save) {
    const date = new Date().toISOString().split("T")[0];
    const path = join(DRAFTS_DIR, `x-bookmarks-${date}.md`);
    const md = fmt.formatResearchMarkdown("Bookmarks", shown, {
      queries: ["bookmarks"],
    });
    writeFileSync(path, md);
    console.error(`\nSaved to ${path}`);
  }

  // Stats
  const filterNote = filtered.length !== tweets.length
    ? ` (${filtered.length} after filters)`
    : "";
  console.error(`\n📑 ${tweets.length} bookmarks fetched${filterNote}, showing ${shown.length}`);
}
