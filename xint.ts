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
 *   watchlist                   Show watchlist
 *   watchlist add <user>        Add user to watchlist
 *   watchlist remove <user>     Remove user from watchlist
 *   watchlist check             Check recent tweets from all watchlist accounts
 *   bookmarks [options]         Fetch your bookmarked tweets (requires OAuth)
 *   likes [options]             Fetch your liked tweets (requires OAuth)
 *   like <tweet_id>             Like a tweet (requires OAuth)
 *   unlike <tweet_id>           Unlike a tweet (requires OAuth)
 *   following [username]        List accounts you follow (requires OAuth)
 *   bookmark <tweet_id>         Bookmark a tweet (requires OAuth)
 *   unbookmark <tweet_id>       Remove a bookmark (requires OAuth)
 *   trends [location] [opts]    Fetch trending topics
 *   analyze <query>             Analyze with Grok AI
 *   costs [today|week|month]    View API cost tracking
 *   auth setup [--manual]       Set up OAuth 2.0 PKCE authentication
 *   auth status                 Check OAuth token status
 *   auth refresh                Manually refresh OAuth tokens
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
import { cmdLikes, cmdLike, cmdUnlike, cmdFollowing, cmdBookmarkSave, cmdUnbookmark } from "./lib/engagement";
import { cmdTrends } from "./lib/trends";
import { cmdAnalyze } from "./lib/grok";
import { cmdCosts, trackCost, checkBudget } from "./lib/costs";
import { cmdWatch } from "./lib/watch";
import { cmdDiff } from "./lib/followers";
import { analyzeSentiment, enrichTweets, computeStats, formatSentimentTweet, formatStats } from "./lib/sentiment";
import { cmdReport } from "./lib/report";
import { fetchArticle, formatArticle } from "./lib/article";

const SKILL_DIR = import.meta.dir;
const WATCHLIST_PATH = join(SKILL_DIR, "data", "watchlist.json");
const DRAFTS_DIR = join(SKILL_DIR, "data", "exports");

// --- Arg parsing ---

const args = process.argv.slice(2);
const command = args[0];

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
  let tweets: api.Tweet[];

  if (cached) {
    tweets = cached;
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

  // Output
  if (asCsv) {
    console.log(fmt.formatCsv(tweets.slice(0, limit)));
  } else if (asJsonl) {
    console.log(fmt.formatJsonl(tweets.slice(0, limit)));
  } else if (asJson) {
    if (sentimentResults) {
      const enriched = enrichTweets(tweets.slice(0, limit), sentimentResults);
      console.log(JSON.stringify(enriched, null, 2));
    } else {
      console.log(JSON.stringify(tweets.slice(0, limit), null, 2));
    }
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
    console.log(JSON.stringify({ user, tweets }, null, 2));
  } else {
    console.log(fmt.formatProfileTelegram(user, tweets));
  }

  warnIfOverBudget();
}

async function cmdTweet() {
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
    console.log(JSON.stringify(tweet, null, 2));
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
  const url = args[1];
  if (!url) {
    console.error("Usage: xint article <url> [--json] [--full] [--model <name>]");
    process.exit(1);
  }

  const asJson = getFlag("json");
  const full = getFlag("full");
  const model = getOpt("model");

  try {
    const article = await fetchArticle(url, { full, model });

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
    default:
      console.log(`auth commands:
  auth setup [--manual]   Set up OAuth 2.0 (PKCE) authentication
  auth status             Check token status
  auth refresh            Manually refresh tokens`);
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
  bookmarks [options]         Fetch your bookmarked tweets (OAuth required)
  likes [options]             Fetch your liked tweets (OAuth required)
  like <tweet_id>             Like a tweet (OAuth required)
  unlike <tweet_id>           Unlike a tweet (OAuth required)
  following [username]        List accounts you follow (OAuth required)
  bookmark <tweet_id>         Bookmark a tweet (OAuth required)
  unbookmark <tweet_id>       Remove a bookmark (OAuth required)
  trends [location] [opts]    Fetch trending topics
  analyze <query>             Analyze with Grok AI (xAI)
  costs [today|week|month]    View API cost tracking & budget
  auth setup [--manual]       Set up OAuth 2.0 PKCE authentication
  auth status                 Check OAuth token status
  auth refresh                Manually refresh OAuth tokens
  watchlist                   Show watchlist
  watchlist add <user> [note] Add user to watchlist
  watchlist remove <user>     Remove user from watchlist
  watchlist check             Check recent from all watchlist accounts
  cache clear                 Clear search cache

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
  --webhook <url>            POST new tweets to this URL as JSON
  --limit <N>                Max tweets per poll (default: 10)
  --since <dur>              Initial seed window (default: 1h)
  --quiet, -q                Suppress per-poll headers
  --jsonl                    Output JSONL for piping

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

async function main() {
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
    default:
      usage();
  }
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
