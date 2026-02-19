#!/usr/bin/env bun
/**
 * xint — X Intelligence CLI.
 *
 * Commands:
 *   search <query> [options]    Search recent tweets
 *   thread <tweet_id>           Fetch full conversation thread
 *   profile <username>          Recent tweets from a user
 *   tweet <tweet_id>            Fetch a single tweet
 *   article <url>               Fetch and read full article content
 *   tui                         Interactive menu for common read-only flows
 *   capabilities                Print machine-readable capability manifest
 *   watchlist                   Show watchlist
 *   watchlist add <user>        Add user to watchlist
 *   watchlist remove <user>     Remove user from watchlist
 *   watchlist check             Check recent tweets from all watchlist accounts
 *   bookmarks [options]         Fetch your bookmarked tweets (requires OAuth)
 *   likes [options]             Fetch your liked tweets (requires OAuth)
 *   like <tweet_id>             Like a tweet (requires OAuth)
 *   unlike <tweet_id>           Unlike a tweet (requires OAuth)
 *   following [username]        List accounts you follow (requires OAuth)
 *   follow <@user|id>           Follow a user (requires OAuth)
 *   unfollow <@user|id>         Unfollow a user (requires OAuth)
 *   media <tweet_id|url>        Download media from a tweet
 *   stream [options]            Stream tweets using X filtered stream (rules-based)
 *   stream-rules [subcommand]   Manage filtered stream rules
 *   lists [subcommand]          Manage your X lists (requires OAuth)
 *   blocks [subcommand]         Manage blocked users (requires OAuth)
 *   mutes [subcommand]          Manage muted users (requires OAuth)
 *   bookmark <tweet_id>         Bookmark a tweet (requires OAuth)
 *   unbookmark <tweet_id>       Remove a bookmark (requires OAuth)
 *   trends [location] [opts]    Fetch trending topics
 *   analyze <query>             Analyze with Grok AI
 *   costs [today|week|month]    View API cost tracking
 *   auth setup [--manual]       Set up OAuth 2.0 PKCE authentication
 *   auth status                 Check OAuth token status
 *   auth refresh                Manually refresh OAuth tokens
 *   package-api-server [opts]   Start local package API server (dev)
 *   cache clear                 Clear search cache
 *
 * Search options:
 *   --sort likes|impressions|retweets|recent   Sort order (default: likes)
 *   --min-likes N              Filter by minimum likes
 *   --min-impressions N        Filter by minimum impressions
 *   --pages N                  Number of pages to fetch (default: 1, max 5)
 *   --no-replies               Exclude replies
 *   --no-retweets              Exclude retweets (added by default)
 *   --limit N                  Max results to display (default: 15)
 *   --quick                    Quick mode: 1 page, noise filter, 1hr cache
 *   --from <username>          Shorthand for from:username in query
 *   --quality                  Pre-filter low-engagement (min_faves:10)
 *   --save                     Save results to data/exports/
 *   --json                     Output raw JSON
 *   --markdown                 Output as markdown (for research docs)
 *
 * Bookmark options:
 *   --limit N                  Max bookmarks to display (default: 20)
 *   --since <dur>              Filter by recency (e.g. 1d, 7d, 1h)
 *   --query <text>             Client-side text filter
 *   --json                     Raw JSON output
 *   --markdown                 Markdown output
 *   --save                     Save to data/exports/
 *   --no-cache                 Skip cache
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import * as api from "./lib/api";
import * as cache from "./lib/cache";
import * as fmt from "./lib/format";
import { authSetup, authStatus, authRefresh } from "./lib/oauth";
import { cmdBookmarks } from "./lib/bookmarks";
import {
  cmdLikes,
  cmdLike,
  cmdUnlike,
  cmdFollowing,
  cmdFollow,
  cmdUnfollow,
  cmdBookmarkSave,
  cmdUnbookmark,
} from "./lib/engagement";
import { cmdTrends } from "./lib/trends";
import { cmdAnalyze } from "./lib/grok";
import { cmdCosts, trackCost, checkBudget } from "./lib/costs";
import { cmdWatch } from "./lib/watch";
import { cmdDiff } from "./lib/followers";
import { analyzeSentiment, enrichTweets, computeStats, formatSentimentTweet, formatStats } from "./lib/sentiment";
import { cmdReport } from "./lib/report";
import { fetchArticle, formatArticle } from "./lib/article";
import { cmdXSearch } from "./lib/x_search";
import { cmdCollections } from "./lib/collections";
import { cmdMCPServer } from "./lib/mcp";
import { cmdLists } from "./lib/lists";
import { cmdBlocks, cmdMutes } from "./lib/moderation";
import { cmdStream, cmdStreamRules } from "./lib/stream";
import { cmdMedia } from "./lib/media";
import { extractTweetId } from "./lib/media";
import { cmdCapabilities } from "./lib/capabilities";
import { buildOutputMeta, printJsonWithMeta, printJsonlWithMeta } from "./lib/output-meta";
import { cmdAuthDoctor, cmdHealth } from "./lib/health";
import { consumeCommandFallback, recordCommandResult } from "./lib/reliability";
import { cmdPackageApiServer } from "./lib/package_api_server";
import { cmdBilling } from "./lib/billing";
import { cmdTui } from "./lib/tui";

const SKILL_DIR = import.meta.dir;
const WATCHLIST_PATH = join(SKILL_DIR, "data", "watchlist.json");
const DRAFTS_DIR = join(SKILL_DIR, "data", "exports");

// --- Arg parsing ---

type PolicyMode = "read_only" | "engagement" | "moderation";
type RequiredMode = PolicyMode;

function policyRank(mode: PolicyMode): number {
  switch (mode) {
    case "read_only": return 1;
    case "engagement": return 2;
    case "moderation": return 3;
  }
}

function parseGlobalPolicy(argv: string[]): PolicyMode {
  let parsed: PolicyMode = "read_only";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--policy") continue;
    const raw = argv[i + 1];
    if (!raw) {
      console.error(`{"error":{"code":"POLICY_INVALID","message":"--policy requires one of: read_only, engagement, moderation"}}`);
      process.exit(2);
    }
    if (raw !== "read_only" && raw !== "engagement" && raw !== "moderation") {
      console.error(`{"error":{"code":"POLICY_INVALID","message":"Invalid --policy value","value":"${raw}"}}`);
      process.exit(2);
    }
    parsed = raw as PolicyMode;
    argv.splice(i, 2);
    i--;
  }
  return parsed;
}

const args = process.argv.slice(2);
const policyMode = parseGlobalPolicy(args);
const command = args[0];

const COMMAND_POLICY: Record<string, RequiredMode> = {
  search: "read_only",
  s: "read_only",
  watch: "read_only",
  w: "read_only",
  diff: "engagement",
  followers: "engagement",
  report: "read_only",
  thread: "read_only",
  t: "read_only",
  profile: "read_only",
  p: "read_only",
  tweet: "read_only",
  media: "read_only",
  article: "read_only",
  read: "read_only",
  tui: "read_only",
  ui: "read_only",
  bookmarks: "engagement",
  bm: "engagement",
  bookmark: "engagement",
  unbookmark: "engagement",
  likes: "engagement",
  like: "engagement",
  unlike: "engagement",
  following: "engagement",
  follow: "engagement",
  unfollow: "engagement",
  lists: "engagement",
  list: "engagement",
  blocks: "moderation",
  block: "moderation",
  mutes: "moderation",
  mute: "moderation",
  trends: "read_only",
  tr: "read_only",
  analyze: "read_only",
  ask: "read_only",
  costs: "read_only",
  cost: "read_only",
  billing: "read_only",
  bill: "read_only",
  auth: "read_only",
  health: "read_only",
  watchlist: "read_only",
  wl: "read_only",
  cache: "read_only",
  "ai-search": "read_only",
  x_search: "read_only",
  xsearch: "read_only",
  collections: "read_only",
  kb: "read_only",
  mcp: "read_only",
  "mcp-server": "read_only",
  "package-api-server": "read_only",
  "pkg-api": "read_only",
  capabilities: "read_only",
  caps: "read_only",
};

function enforcePolicyOrExit(cmd?: string): void {
  if (!cmd) return;
  const required = COMMAND_POLICY[cmd] || "read_only";
  if (policyRank(policyMode) >= policyRank(required)) return;
  const payload = {
    error: {
      code: "POLICY_DENIED",
      message: `Command '${cmd}' requires '${required}' policy mode`,
      command: cmd,
      policy_mode: policyMode,
      required_mode: required,
    },
  };
  console.error(JSON.stringify(payload));
  process.exit(2);
}

function getFlag(name: string): boolean {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0) {
    args.splice(idx, 1);
    return true;
  }
  return false;
}

function getOpt(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < args.length) {
    const val = args[idx + 1];
    args.splice(idx, 2);
    return val;
  }
  return undefined;
}

// --- Watchlist ---

interface Watchlist {
  accounts: { username: string; note?: string; addedAt: string }[];
}

function loadWatchlist(): Watchlist {
  if (!existsSync(WATCHLIST_PATH))
    return { accounts: [] };
  return JSON.parse(readFileSync(WATCHLIST_PATH, "utf-8"));
}

function saveWatchlist(wl: Watchlist) {
  writeFileSync(WATCHLIST_PATH, JSON.stringify(wl, null, 2));
}

// --- Budget check helper ---

function warnIfOverBudget(): void {
  const budget = checkBudget();
  if (!budget.allowed) {
    console.error(`\n!! Daily budget exceeded: $${budget.spent.toFixed(2)} / $${budget.limit.toFixed(2)}`);
    console.error(`   Use 'costs budget set <N>' to adjust, or 'costs reset' to clear today.`);
  } else if (budget.warning) {
    console.error(`\n! Budget warning: $${budget.spent.toFixed(2)} / $${budget.limit.toFixed(2)} (${Math.round(budget.spent / budget.limit * 100)}%)`);
  }
}

// --- Commands ---

async function cmdSearch() {
  const startedAtMs = Date.now();
  // Parse new flags first (before getOpt consumes positional args)
  const quick = getFlag("quick");
  const quality = getFlag("quality");
  const fromUser = getOpt("from");

  const sortOpt = getOpt("sort") || "likes";
  const minLikes = parseInt(getOpt("min-likes") || "0");
  const minImpressions = parseInt(getOpt("min-impressions") || "0");
  let pages = Math.min(parseInt(getOpt("pages") || "1"), 5);
  let limit = parseInt(getOpt("limit") || "15");
  const since = getOpt("since");
  const until = getOpt("until");
  const fullArchive = getFlag("full");
  const noReplies = getFlag("no-replies");
  const noRetweets = getFlag("no-retweets");
  const save = getFlag("save");
  const asJson = getFlag("json");
  const asMarkdown = getFlag("markdown");
  const asCsv = getFlag("csv");
  const asJsonl = getFlag("jsonl");
  const withSentiment = getFlag("sentiment");

  // Quick mode overrides
  if (quick) {
    pages = 1;
    limit = Math.min(limit, 10);
  }

  // Everything after "search" that isn't a flag is the query
  const queryParts = args.slice(1).filter((a) => !a.startsWith("--"));
  let query = queryParts.join(" ");

  if (!query) {
    console.error("Usage: xint search <query> [options]");
    process.exit(1);
  }

  // --from shorthand: add from:username if not already in query
  if (fromUser && !query.toLowerCase().includes("from:")) {
    query += ` from:${fromUser.replace(/^@/, "")}`;
  }

  // Auto-add noise filters unless already present
  if (!query.includes("is:retweet") && !noRetweets) {
    query += " -is:retweet";
  }
  if (quick && !query.includes("is:reply")) {
    query += " -is:reply";
  } else if (noReplies && !query.includes("is:reply")) {
    query += " -is:reply";
  }

  // Cache TTL: 1hr for quick mode, 15min default
  const cacheTtlMs = quick ? 3_600_000 : 900_000;

  // Check cache (cache key does NOT include quick flag — shared between modes)
  const cacheParams = `sort=${sortOpt}&pages=${pages}&since=${since || "7d"}`;
  const cached = cache.get(query, cacheParams, cacheTtlMs);
  let cacheHit = false;
  let tweets: api.Tweet[];

  if (cached) {
    tweets = cached;
    cacheHit = true;
    console.error(`(cached — ${tweets.length} tweets)`);
  } else {
    tweets = await api.search(query, {
      pages,
      sortOrder: sortOpt === "recent" ? "recency" : "relevancy",
      since: since || undefined,
      until: until || undefined,
      fullArchive,
    });
    cache.set(query, cacheParams, tweets);
  }

  // Track raw count for cost (API charges per tweet read, regardless of post-hoc filters)
  const rawTweetCount = tweets.length;

  // Track cost
  if (!cached) {
    const op = fullArchive ? "search_archive" : "search";
    trackCost(op, fullArchive ? "/2/tweets/search/all" : "/2/tweets/search/recent", rawTweetCount);
  }

  // Filter
  if (minLikes > 0 || minImpressions > 0) {
    tweets = api.filterEngagement(tweets, {
      minLikes: minLikes || undefined,
      minImpressions: minImpressions || undefined,
    });
  }

  // --quality: post-hoc filter for min 10 likes (min_faves not available as a search operator)
  if (quality) {
    tweets = api.filterEngagement(tweets, { minLikes: 10 });
  }

  // Sort
  if (sortOpt !== "recent") {
    const metric = sortOpt as "likes" | "impressions" | "retweets";
    tweets = api.sortBy(tweets, metric);
  }

  tweets = api.dedupe(tweets);

  // Sentiment analysis (optional, runs before output)
  let sentimentResults: Awaited<ReturnType<typeof analyzeSentiment>> | null = null;
  if (withSentiment) {
    console.error(`Running sentiment analysis on ${Math.min(tweets.length, limit)} tweets...`);
    sentimentResults = await analyzeSentiment(tweets.slice(0, limit));
  }

  const shown = tweets.slice(0, limit);
  const endpoint = fullArchive ? "/2/tweets/search/all" : "/2/tweets/search/recent";
  const estimatedCostUsd = cacheHit ? 0 : rawTweetCount * (fullArchive ? 0.01 : 0.005);
  const outputMeta = buildOutputMeta({
    source: "x_api_v2",
    startedAtMs,
    cached: cacheHit,
    confidence: 1,
    apiEndpoint: endpoint,
    estimatedCostUsd,
  });

  // Output
  if (asCsv) {
    console.log(fmt.formatCsv(shown));
  } else if (asJsonl) {
    const payload = sentimentResults ? enrichTweets(shown, sentimentResults) : shown;
    printJsonlWithMeta(outputMeta, payload, "tweet");
  } else if (asJson) {
    const payload = sentimentResults ? enrichTweets(shown, sentimentResults) : shown;
    printJsonWithMeta(outputMeta, payload);
  } else if (asMarkdown) {
    const md = fmt.formatResearchMarkdown(query, tweets, {
      queries: [query],
    });
    console.log(md);
  } else if (sentimentResults) {
    const enriched = enrichTweets(tweets.slice(0, limit), sentimentResults);
    for (const [i, t] of enriched.entries()) {
      console.log(formatSentimentTweet(t, i));
      console.log();
    }
    const stats = computeStats(sentimentResults);
    console.log(formatStats(stats, sentimentResults.length));
  } else {
    console.log(fmt.formatResultsTelegram(tweets, { query, limit }));
  }

  // Save
  if (save) {
    const slug = query
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)
      .toLowerCase();
    const date = new Date().toISOString().split("T")[0];
    const path = join(DRAFTS_DIR, `xint-${slug}-${date}.md`);
    const md = fmt.formatResearchMarkdown(query, tweets, {
      queries: [query],
    });
    writeFileSync(path, md);
    console.error(`\nSaved to ${path}`);
  }

  // Cost display (based on raw API reads, not post-filter count)
  const cost = (rawTweetCount * 0.005).toFixed(2);
  if (quick) {
    console.error(`\n\u26A1 quick mode \u00B7 ${rawTweetCount} tweets read (~$${cost})`);
  } else {
    console.error(`\n\uD83D\uDCCA ${rawTweetCount} tweets read \u00B7 est. cost ~$${cost}`);
  }

  // Stats to stderr
  const filtered = rawTweetCount !== tweets.length ? ` \u2192 ${tweets.length} after filters` : "";
  const sinceLabel = since ? ` | since ${since}` : "";
  const archiveLabel = fullArchive ? " | FULL ARCHIVE" : "";
  console.error(
    `${rawTweetCount} tweets${filtered} | sorted by ${sortOpt} | ${pages} page(s)${sinceLabel}${archiveLabel}`
  );

  warnIfOverBudget();
}

async function cmdThread() {
  const tweetId = args[1];
  if (!tweetId) {
    console.error("Usage: xint thread <tweet_id>");
    process.exit(1);
  }

  const pages = Math.min(parseInt(getOpt("pages") || "2"), 5);
  const tweets = await api.thread(tweetId, { pages });

  // Track cost
  trackCost("thread", "/2/tweets/search/recent", tweets.length);

  if (tweets.length === 0) {
    console.log("No tweets found in thread.");
    return;
  }

  console.log(`\uD83E\uDDF5 Thread (${tweets.length} tweets)\n`);
  for (const t of tweets) {
    console.log(fmt.formatTweetTelegram(t, undefined, { full: true }));
    console.log();
  }

  warnIfOverBudget();
}

async function cmdProfile() {
  const startedAtMs = Date.now();
  const username = args[1]?.replace(/^@/, "");
  if (!username) {
    console.error("Usage: xint profile <username>");
    process.exit(1);
  }

  const count = parseInt(getOpt("count") || "20");
  const includeReplies = getFlag("replies");
  const asJson = getFlag("json");

  const { user, tweets } = await api.profile(username, {
    count,
    includeReplies,
  });

  // Track cost
  trackCost("profile", `/2/users/by/username/${username}`, tweets.length + 1);

  if (asJson) {
    const outputMeta = buildOutputMeta({
      source: "x_api_v2",
      startedAtMs,
      cached: false,
      confidence: 1,
      apiEndpoint: `/2/users/by/username/${username}`,
      estimatedCostUsd: (tweets.length + 1) * 0.005,
    });
    printJsonWithMeta(outputMeta, { user, tweets });
  } else {
    console.log(fmt.formatProfileTelegram(user, tweets));
  }

  warnIfOverBudget();
}

async function cmdTweet() {
  const startedAtMs = Date.now();
  const tweetId = args[1];
  if (!tweetId) {
    console.error("Usage: xint tweet <tweet_id>");
    process.exit(1);
  }

  const tweet = await api.getTweet(tweetId);

  // Track cost
  trackCost("tweet", `/2/tweets/${tweetId}`, tweet ? 1 : 0);

  if (!tweet) {
    console.log("Tweet not found.");
    return;
  }

  const asJson = getFlag("json");
  if (asJson) {
    const outputMeta = buildOutputMeta({
      source: "x_api_v2",
      startedAtMs,
      cached: false,
      confidence: tweet ? 1 : 0,
      apiEndpoint: `/2/tweets/${tweetId}`,
      estimatedCostUsd: 0.005,
    });
    printJsonWithMeta(outputMeta, tweet);
  } else {
    console.log(fmt.formatTweetTelegram(tweet, undefined, { full: true }));
  }
}

async function cmdWatchlist() {
  const sub = args[1];
  const wl = loadWatchlist();

  if (sub === "add") {
    const username = args[2]?.replace(/^@/, "");
    const note = args.slice(3).join(" ") || undefined;
    if (!username) {
      console.error("Usage: xint watchlist add <username> [note]");
      process.exit(1);
    }
    if (wl.accounts.find((a) => a.username.toLowerCase() === username.toLowerCase())) {
      console.log(`@${username} already on watchlist.`);
      return;
    }
    wl.accounts.push({
      username,
      note,
      addedAt: new Date().toISOString(),
    });
    saveWatchlist(wl);
    console.log(`Added @${username} to watchlist.${note ? ` (${note})` : ""}`);
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const username = args[2]?.replace(/^@/, "");
    if (!username) {
      console.error("Usage: xint watchlist remove <username>");
      process.exit(1);
    }
    const before = wl.accounts.length;
    wl.accounts = wl.accounts.filter(
      (a) => a.username.toLowerCase() !== username.toLowerCase()
    );
    saveWatchlist(wl);
    console.log(
      wl.accounts.length < before
        ? `Removed @${username} from watchlist.`
        : `@${username} not found on watchlist.`
    );
    return;
  }

  if (sub === "check") {
    if (wl.accounts.length === 0) {
      console.log("Watchlist is empty. Add accounts with: watchlist add <username>");
      return;
    }
    console.log(`Checking ${wl.accounts.length} watchlist accounts...\n`);
    for (const acct of wl.accounts) {
      try {
        const { user, tweets } = await api.profile(acct.username, { count: 5 });
        trackCost("profile", `/2/users/by/username/${acct.username}`, tweets.length + 1);
        const label = acct.note ? ` (${acct.note})` : "";
        console.log(`\n--- @${acct.username}${label} ---`);
        if (tweets.length === 0) {
          console.log("  No recent tweets.");
        } else {
          for (const t of tweets.slice(0, 3)) {
            console.log(fmt.formatTweetTelegram(t));
            console.log();
          }
        }
      } catch (e: any) {
        console.error(`  Error checking @${acct.username}: ${e.message}`);
      }
    }
    warnIfOverBudget();
    return;
  }

  // Default: show watchlist
  if (wl.accounts.length === 0) {
    console.log("Watchlist is empty. Add accounts with: watchlist add <username>");
    return;
  }
  console.log(`\uD83D\uDCCB Watchlist (${wl.accounts.length} accounts)\n`);
  for (const acct of wl.accounts) {
    const note = acct.note ? ` \u2014 ${acct.note}` : "";
    console.log(`  @${acct.username}${note} (added ${acct.addedAt.split("T")[0]})`);
  }
}

async function cmdCache() {
  const sub = args[1];
  if (sub === "clear") {
    const removed = cache.clear();
    console.log(`Cleared ${removed} cached entries.`);
  } else {
    const removed = cache.prune();
    console.log(`Pruned ${removed} expired entries.`);
  }
}

async function cmdArticle() {
  let url = args[1];
  if (!url) {
    console.error("Usage: xint article <url> [--json] [--full] [--model <name>] [--ai <prompt>]");
    console.error("       xint article <x-tweet-url> [--ai <prompt>]  # Auto-extract linked article");
    process.exit(1);
  }

  const asJson = getFlag("json");
  const full = getFlag("full");
  const model = getOpt("model");
  const aiPrompt = getOpt("ai");

  try {
    let article;
    
    // Check if it's an X tweet URL - extract linked article
    if (extractTweetId(url)) {
      console.log("🔍 Fetching tweet to extract linked article...");
      const { fetchTweetForArticle } = await import("./lib/article");
      const { tweet, articleUrl } = await fetchTweetForArticle(url);
      
      if (!articleUrl) {
        console.log("📝 No external link found in tweet.");
        console.log(`   Tweet: ${tweet.text?.slice(0, 200)}...`);
        console.log(`   URL: ${tweet.tweet_url}`);
        process.exit(0);
      }
      
      console.log(`📄 Found link: ${articleUrl}\n`);
      url = articleUrl;
    }

    // Fetch the article
    article = await fetchArticle(url, { full, model });

    // If AI prompt provided, analyze the article
    if (aiPrompt) {
      console.log("🤖 Analyzing with Grok...\n");
      const { analyzeQuery } = await import("./lib/grok");
      const analysis = await analyzeQuery(aiPrompt, article.content, { model: model || undefined });
      console.log(`📝 Analysis: ${aiPrompt}\n`);
      console.log(analysis.content);
      console.log(`\n---`);
    }

    if (asJson) {
      console.log(JSON.stringify(article, null, 2));
    } else {
      console.log(formatArticle(article));
    }
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

async function cmdAuth() {
  const sub = args[1];

  switch (sub) {
    case "setup": {
      const manual = args.includes("--manual");
      await authSetup(manual);
      break;
    }
    case "status":
      authStatus();
      break;
    case "refresh":
      await authRefresh();
      break;
    case "doctor":
      await cmdAuthDoctor(args.slice(2));
      break;
    default:
      console.log(`auth commands:
  auth setup [--manual]   Set up OAuth 2.0 (PKCE) authentication
  auth status             Check token status
  auth refresh            Manually refresh tokens
  auth doctor [--json]    Validate auth credentials and scopes`);
  }
}

function usage() {
  console.log(`xint \u2014 X Intelligence CLI

Commands:
  search <query> [options]    Search tweets (recent or full archive)
  watch <query> [options]     Monitor X in real-time (polls on interval)
  diff <@user> [options]      Track follower/following changes over time
  report <topic> [options]    Generate intelligence report with AI analysis
  thread <tweet_id>           Fetch full conversation thread
  profile <username>          Recent tweets from a user
  tweet <tweet_id>            Fetch a single tweet
  article <url>               Fetch and read full article content
  tui                         Interactive menu for common read-only workflows
  capabilities                Print machine-readable capability manifest
  bookmarks [options]         Fetch your bookmarked tweets (OAuth required)
  likes [options]             Fetch your liked tweets (OAuth required)
  like <tweet_id>             Like a tweet (OAuth required)
  unlike <tweet_id>           Unlike a tweet (OAuth required)
  following [username]        List accounts you follow (OAuth required)
  follow <@user|id>           Follow a user (OAuth required)
  unfollow <@user|id>         Unfollow a user (OAuth required)
  media <tweet_id|url>        Download media from a tweet
  stream [options]            Stream tweets using X filtered stream
  stream-rules [subcmd]       Manage filtered stream rules
  lists [subcmd]              Manage your X lists (OAuth required)
  blocks [subcmd]             Manage blocked users (OAuth required)
  mutes [subcmd]              Manage muted users (OAuth required)
  bookmark <tweet_id>         Bookmark a tweet (OAuth required)
  unbookmark <tweet_id>       Remove a bookmark (OAuth required)
  trends [location] [opts]    Fetch trending topics
  analyze <query>             Analyze with Grok AI (xAI)
  costs [today|week|month]    View API cost tracking & budget
  billing [status|usage]      View package API entitlements and usage
  health [--json]             Runtime health, auth checks, and reliability stats
  auth setup [--manual]       Set up OAuth 2.0 PKCE authentication
  auth status                 Check OAuth token status
  auth refresh                Manually refresh OAuth tokens
  auth doctor [--json]        Validate auth credentials and scopes
  watchlist                   Show watchlist
  watchlist add <user> [note] Add user to watchlist
  watchlist remove <user>     Remove user from watchlist
  watchlist check             Check recent from all watchlist accounts
  cache clear                 Clear search cache
  --policy <mode>             Global policy: read_only | engagement | moderation
  ai-search <file>           Search X via xAI's x_search tool (AI-powered)
  collections <subcmd>       Manage xAI Collections Knowledge Base
  mcp-server [options]        Start MCP server for AI agents (Claude, OpenAI)
  package-api-server [opts]   Run local package API for Agent Memory v1
  capabilities [--compact]    Print JSON capability/pricing/policy schema

MCP Server options:
  --sse                       Run in SSE mode (HTTP server)
  --port=<N>                  Port for SSE mode (default: 3000)
  --host=<addr>               Host bind for SSE mode (default: 127.0.0.1)
  --auth-token=<token>        Require bearer auth for /mcp and /sse
  --policy=<mode>             MCP policy mode: read_only|engagement|moderation
  --no-budget-guard           Disable budget guard for tool calls
  Run without flags for stdio mode (for Claude Code integration)
  Env: XINT_MCP_HOST, XINT_MCP_AUTH_TOKEN

Package API server options:
  --port=<N>                  Port for local package API (default: 8080)
  Set XINT_PACKAGE_API_KEY to require bearer auth for local calls

Search options:
  --sort likes|impressions|retweets|recent   (default: likes)
  --since 1h|3h|12h|1d|7d   Time filter (default: last 7 days)
  --until <date>             End time filter (full-archive only)
  --full                     Full-archive search (back to 2006, pay-per-use)
  --min-likes N              Filter minimum likes
  --min-impressions N        Filter minimum impressions
  --pages N                  Pages to fetch, 1-5 (default: 1)
  --limit N                  Results to display (default: 15)
  --quick                    Quick mode: 1 page, max 10 results, auto noise
                             filter, 1hr cache TTL, cost summary
  --from <username>          Shorthand for from:username in query
  --quality                  Pre-filter low-engagement tweets (min_faves:10)
  --sentiment                AI sentiment analysis via Grok (per-tweet scores)
  --no-replies               Exclude replies
  --save                     Save to data/exports/
  --json                     Raw JSON output
  --jsonl                    JSONL output (one tweet per line, pipeable)
  --csv                      CSV output (spreadsheet-friendly)
  --markdown                 Markdown output

Watch options:
  --interval, -i <dur>       Polling interval: 30s, 5m, 1h (default: 5m)
  --webhook <url>            POST new tweets to this URL as JSON (https:// required for remote hosts)
  --limit <N>                Max tweets per poll (default: 10)
  --since <dur>              Initial seed window (default: 1h)
  --quiet, -q                Suppress per-poll headers
  --jsonl                    Output JSONL for piping

Stream options:
  --json                     Output JSON per stream event
  --jsonl                    Output JSONL per stream event
  --max-events N             Stop after N events
  --backfill N               Backfill 1-5 minutes (X API option)
  --webhook <url>            POST event payloads to URL (https:// required for remote hosts)
  --quiet, -q                Suppress stream status logs

Stream rules options:
  xint stream-rules [list|add|delete|clear]
  Run 'xint stream-rules --help' for full examples

Diff options:
  --following                Track following list instead of followers
  --history                  Show all saved snapshots
  --pages <N>                Max pages to fetch (default: 5, ~5000 users)
  --json                     Output as JSON

Report options:
  --accounts, -a <list>      Comma-separated accounts (e.g., @user1,@user2)
  --sentiment, -s            Include sentiment analysis
  --model <name>             Grok model (default: grok-3-mini)
  --pages <N>                Search pages (default: 2)
  --save                     Save report to data/exports/

Bookmark/Like options:
  --limit N                  Max to display (default: 20)
  --since <dur>              Filter by recency (1h, 1d, 7d, etc.)
  --query <text>             Client-side text filter
  --json                     Raw JSON output
  --markdown                 Markdown output
  --save                     Save to data/exports/
  --no-cache                 Skip cache
  follow/unfollow also accept: --json

Media options:
  --dir <path>               Output directory (default: data/media)
  --max-items <N>            Download up to N media items
  --name-template <tpl>      Filename template tokens:
                             {tweet_id} {username} {index} {type}
                             {media_key} {created_at} {ext}
  --photos-only              Download photos only
  --video-only               Download videos/GIFs only
  --json                     Output JSON summary

Lists options:
  xint lists [list|create|update|delete|members]
  Run 'xint lists' for full subcommand help and examples

Blocks/Mutes options:
  xint blocks [list|add|remove]
  xint mutes [list|add|remove]
  Run 'xint blocks --help' or 'xint mutes --help' for examples

Trends options:
  [location]                 Location name or WOEID (default: worldwide)
  --limit N                  Number of trends (default: 20)
  --json                     Raw JSON output
  --no-cache                 Skip cache
  --locations                List known location names

Analyze options:
  <query>                    Ask Grok a question
  --tweets <file>            Analyze tweets from a JSON file
  --pipe                     Read tweet JSON from stdin
  --model <name>             grok-3, grok-3-mini (default), grok-2
  --system <prompt>          Custom system prompt

Costs options:
  [today|week|month|all]     Period to show (default: today)
  budget                     Show budget info
  budget set <N>             Set daily budget limit in USD
  reset                      Reset today's cost data`);
}

// --- Main ---

function metricCommandName(cmd?: string): string | null {
  if (!cmd) return null;
  if (cmd === "s") return "search";
  if (cmd === "w") return "watch";
  if (cmd === "t") return "thread";
  if (cmd === "p") return "profile";
  if (cmd === "tr") return "trends";
  if (cmd === "cost") return "costs";
  if (cmd === "bill") return "billing";
  if (cmd === "bm") return "bookmarks";
  if (cmd === "caps") return "capabilities";
  if (cmd === "wl") return "watchlist";
  if (cmd === "kb") return "collections";
  if (cmd === "mcp") return "mcp-server";
  if (cmd === "pkg-api") return "package-api-server";
  if (cmd === "stream_rules") return "stream-rules";
  if (cmd === "bm-save") return "bookmark";
  if (cmd === "bm-remove") return "unbookmark";
  if (cmd === "followers") return "diff";
  if (cmd === "ask") return "analyze";
  if (cmd === "read") return "article";
  if (cmd === "ui") return "tui";
  if (cmd === "x_search" || cmd === "xsearch" || cmd === "ai-search") return "ai-search";
  if (cmd === "list") return "lists";
  if (cmd === "block") return "blocks";
  if (cmd === "mute") return "mutes";
  const known = new Set([
    "search", "watch", "diff", "report", "thread", "profile", "tweet", "article", "tui",
    "bookmarks", "likes", "like", "unlike", "following", "follow", "unfollow",
    "media", "stream", "stream-rules", "lists", "blocks", "mutes", "bookmark",
    "unbookmark", "trends", "analyze", "costs", "health", "auth", "watchlist",
    "cache", "ai-search", "collections", "mcp-server", "package-api-server", "capabilities", "billing",
  ]);
  return known.has(cmd) ? cmd : null;
}

async function main() {
  enforcePolicyOrExit(command);
  const metricCommand = metricCommandName(command);
  const startedAtMs = Date.now();

  try {
    switch (command) {
      case "search":
      case "s":
        await cmdSearch();
        break;
      case "thread":
      case "t":
        await cmdThread();
        break;
      case "profile":
      case "p":
        await cmdProfile();
        break;
      case "tweet":
        await cmdTweet();
        break;
      case "article":
      case "read":
        await cmdArticle();
        break;
      case "tui":
      case "ui":
        await cmdTui();
        break;
      case "bookmarks":
      case "bm":
        await cmdBookmarks(args.slice(1));
        break;
      case "likes":
        await cmdLikes(args.slice(1));
        break;
      case "like":
        await cmdLike(args.slice(1));
        break;
      case "unlike":
        await cmdUnlike(args.slice(1));
        break;
      case "following":
        await cmdFollowing(args.slice(1));
        break;
      case "follow":
        await cmdFollow(args.slice(1));
        break;
      case "unfollow":
        await cmdUnfollow(args.slice(1));
        break;
      case "media":
        await cmdMedia(args.slice(1));
        break;
      case "stream":
        await cmdStream(args.slice(1));
        break;
      case "stream-rules":
      case "stream_rules":
        await cmdStreamRules(args.slice(1));
        break;
      case "lists":
      case "list":
        await cmdLists(args.slice(1));
        break;
      case "blocks":
      case "block":
        await cmdBlocks(args.slice(1));
        break;
      case "mutes":
      case "mute":
        await cmdMutes(args.slice(1));
        break;
      case "bookmark":
      case "bm-save":
        await cmdBookmarkSave(args.slice(1));
        break;
      case "unbookmark":
      case "bm-remove":
        await cmdUnbookmark(args.slice(1));
        break;
      case "trends":
      case "tr":
        await cmdTrends(args.slice(1));
        break;
      case "analyze":
      case "ask":
        await cmdAnalyze(args.slice(1));
        break;
      case "costs":
      case "cost":
        cmdCosts(args.slice(1));
        break;
      case "billing":
      case "bill":
        await cmdBilling(args.slice(1));
        break;
      case "health":
        await cmdHealth(args.slice(1));
        break;
      case "auth":
        await cmdAuth();
        break;
      case "watchlist":
      case "wl":
        await cmdWatchlist();
        break;
      case "cache":
        await cmdCache();
        break;
      case "watch":
      case "w":
        await cmdWatch(args.slice(1));
        break;
      case "diff":
      case "followers":
        await cmdDiff(args.slice(1));
        break;
      case "report":
        await cmdReport(args.slice(1));
        break;
      case "ai-search":
      case "x_search":
      case "xsearch":
        await cmdXSearch(args.slice(1));
        break;
      case "collections":
      case "kb":
        await cmdCollections(args.slice(1));
        break;
      case "mcp":
      case "mcp-server":
        process.env.XINT_POLICY_MODE = policyMode;
        await cmdMCPServer(args.slice(1));
        break;
      case "package-api-server":
      case "pkg-api":
        await cmdPackageApiServer(args.slice(1));
        break;
      case "capabilities":
      case "caps":
        cmdCapabilities(args.slice(1));
        break;
      default:
        usage();
    }
    if (metricCommand) {
      const fallback = consumeCommandFallback(metricCommand);
      recordCommandResult(metricCommand, true, Date.now() - startedAtMs, { mode: "cli", fallback });
    }
  } catch (error) {
    if (metricCommand) {
      const fallback = consumeCommandFallback(metricCommand);
      recordCommandResult(metricCommand, false, Date.now() - startedAtMs, { mode: "cli", fallback });
    }
    throw error;
  }
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
