/**
 * lib/watch.ts — Real-time monitoring for X/Twitter searches.
 *
 * Polls a search query on an interval, displays only new tweets since
 * the last check. Supports webhook notifications and desktop alerts.
 */

import * as api from "./api";
import * as cache from "./cache";
import * as fmt from "./format";
import { trackCost, checkBudget } from "./costs";
import { buildOutputMeta } from "./output-meta";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WatchOpts {
  interval: number;        // polling interval in ms
  webhook?: string;        // POST new tweets to this URL
  limit?: number;          // max tweets to show per poll
  sort?: string;          // sort order
  since?: string;          // initial time window
  quiet?: boolean;        // suppress per-poll headers
  jsonl?: boolean;        // output JSONL instead of formatted
  stream?: boolean;       // output SSE (Server-Sent Events)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDuration(s: string): number | null {
  const m = s.match(/^(\d+)(s|m|h)$/);
  if (!m) return null;
  const n = parseInt(m[1]);
  switch (m[2]) {
    case "s": return n * 1000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
  }
  return null;
}

function nowIso(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

async function postWebhook(url: string, tweets: api.Tweet[], query: string): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "xint",
        query,
        timestamp: new Date().toISOString(),
        count: tweets.length,
        tweets: tweets.map(t => ({
          id: t.id,
          username: t.username,
          text: t.text,
          likes: t.metrics.likes,
          retweets: t.metrics.retweets,
          url: t.tweet_url,
          created_at: t.created_at,
        })),
      }),
    });
  } catch (e: any) {
    console.error(`[webhook] Failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Watch loop
// ---------------------------------------------------------------------------

export async function watch(query: string, opts: WatchOpts): Promise<void> {
  const seenIds = new Set<string>();
  let pollCount = 0;
  let totalNew = 0;
  let totalCost = 0;
  const startTime = Date.now();

  // Graceful shutdown
  let running = true;
  const cleanup = () => {
    running = false;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    console.error(`\n--- Watch stopped ---`);
    console.error(`Duration: ${mins}m ${secs}s | Polls: ${pollCount} | New tweets: ${totalNew} | Est. cost: ~$${totalCost.toFixed(3)}`);
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const intervalStr = opts.interval >= 3_600_000
    ? `${(opts.interval / 3_600_000).toFixed(0)}h`
    : opts.interval >= 60_000
      ? `${(opts.interval / 60_000).toFixed(0)}m`
      : `${(opts.interval / 1000).toFixed(0)}s`;

  console.error(`\nWatching: "${query}" every ${intervalStr}`);
  if (opts.webhook) console.error(`Webhook: ${opts.webhook}`);
  console.error(`Press Ctrl+C to stop\n`);

  while (running) {
    try {
      const pollStartedAtMs = Date.now();
      const tweets = await api.search(query, {
        pages: 1,
        sortOrder: "recency",
        since: opts.since || "1h",
      });

      // Track cost
      const cost = tweets.length * 0.005;
      totalCost += cost;
      trackCost("search", "/2/tweets/search/recent", tweets.length);
      pollCount++;

      // Filter to only new tweets
      const newTweets = tweets.filter(t => !seenIds.has(t.id));

      // Mark all as seen
      for (const t of tweets) seenIds.add(t.id);

      if (newTweets.length > 0) {
        totalNew += newTweets.length;
        const limited = newTweets.slice(0, opts.limit || 10);

        // SSE streaming output
        if (opts.stream) {
          for (const t of limited) {
            const sseData = {
              event: "tweet",
              data: {
                query,
                timestamp: new Date().toISOString(),
                tweet: t,
              },
            };
            console.log(`event: tweet\ndata: ${JSON.stringify(sseData.data)}\n`);
          }
        } else if (!opts.quiet) {
          console.error(`\n[${nowIso()}] +${newTweets.length} new`);
        }

        if (opts.jsonl) {
          for (const t of limited) {
            const meta = buildOutputMeta({
              source: "x_api_v2",
              startedAtMs: pollStartedAtMs,
              cached: false,
              confidence: 1,
              apiEndpoint: "/2/tweets/search/recent",
              estimatedCostUsd: 0.005,
            });
            console.log(JSON.stringify({ ...meta, tweet: t }));
          }
        } else if (!opts.stream) {
          for (const t of limited) {
            console.log(fmt.formatTweetTelegram(t, undefined, { full: false }));
            console.log();
          }
        }

        // Webhook
        if (opts.webhook) {
          await postWebhook(opts.webhook, limited, query);
        }
      } else if (pollCount === 1) {
        // First poll — seed with existing tweets but don't show them
        console.error(`[${nowIso()}] Seeded with ${tweets.length} existing tweets (watching for new)`);
      }

      // Budget check
      const budget = checkBudget();
      if (!budget.allowed) {
        console.error(`\n!! Budget exceeded ($${budget.spent.toFixed(2)}/$${budget.limit.toFixed(2)}). Stopping watch.`);
        break;
      }

    } catch (e: any) {
      if (e.message.includes("Rate limited")) {
        const waitMatch = e.message.match(/(\d+)s/);
        const waitSec = waitMatch ? parseInt(waitMatch[1]) : 60;
        console.error(`[${nowIso()}] Rate limited, waiting ${waitSec}s...`);
        await api.sleep(waitSec * 1000);
        continue;
      }
      console.error(`[${nowIso()}] Error: ${e.message}`);
    }

    // Wait for next interval
    await api.sleep(opts.interval);
  }
}

// ---------------------------------------------------------------------------
// CLI handler
// ---------------------------------------------------------------------------

export async function cmdWatch(args: string[]): Promise<void> {
  const queryParts: string[] = [];
  let interval = 5 * 60_000; // default 5m
  let webhook: string | undefined;
  let limit: number | undefined;
  let since: string | undefined;
  let quiet = false;
  let jsonl = false;
  let stream = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--interval":
      case "-i": {
        const val = args[++i];
        if (!val) {
          console.error("Error: --interval requires a value (e.g., 5m, 30s, 1h)");
          process.exit(1);
        }
        const parsed = parseDuration(val);
        if (!parsed) {
          console.error(`Error: invalid interval "${val}". Use format: 30s, 5m, 1h`);
          process.exit(1);
        }
        if (parsed < 10_000) {
          console.error("Error: minimum interval is 10s");
          process.exit(1);
        }
        interval = parsed;
        break;
      }
      case "--webhook":
        webhook = args[++i];
        break;
      case "--limit":
        limit = parseInt(args[++i] || "10");
        break;
      case "--since":
        since = args[++i];
        break;
      case "--quiet":
      case "-q":
        quiet = true;
        break;
      case "--jsonl":
        jsonl = true;
        break;
      case "--stream":
      case "-s":
        stream = true;
        break;
      case "--help":
      case "-h":
        printWatchHelp();
        return;
      default:
        queryParts.push(arg);
    }
    i++;
  }

  let query = queryParts.join(" ");
  if (!query) {
    printWatchHelp();
    return;
  }

  // Auto-expand @username to from:username
  if (query.startsWith("@") && !query.includes(" ")) {
    query = `from:${query.slice(1)}`;
  }

  // Auto-add noise filters
  if (!query.includes("is:retweet")) {
    query += " -is:retweet";
  }

  await watch(query, { interval, webhook, limit, since, quiet, jsonl, stream });
}

function printWatchHelp(): void {
  console.log(`
Usage: xint watch <query> [options]

Monitor X in real-time. Polls a search query on interval and shows
only new tweets since the last check.

Options:
  --interval, -i <dur>   Polling interval: 30s, 5m, 1h (default: 5m)
  --webhook <url>        POST new tweets to this URL as JSON
  --limit <N>            Max tweets to show per poll (default: 10)
  --since <dur>          Initial time window to seed from (default: 1h)
  --quiet, -q            Suppress per-poll headers
  --jsonl                Output JSONL (one tweet per line)
  --stream, -s           Output SSE (Server-Sent Events)

Examples:
  xint watch "solana memecoins" --interval 5m
  xint watch "@vitalikbuterin" --interval 1m
  xint watch "AI agents" -i 30s --webhook https://hooks.slack.com/...
  xint watch "breaking news" --jsonl | tee -a feed.jsonl
  xint watch "AI news" --stream | sse-consumer
`);
}
