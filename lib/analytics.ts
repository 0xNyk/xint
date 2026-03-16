import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { loadTokens, getValidToken } from "./oauth";
import { getUserTimeline, type TweetWithEngagement } from "./timeline";
import { trackCost } from "./costs";
import { bold, cyan, yellow, dim, green, red } from "./format";

const SKILL_DIR = import.meta.dir;
const EXPORTS_DIR = join(SKILL_DIR, "..", "data", "exports");

function ensureExportsDir(): void {
  if (!existsSync(EXPORTS_DIR)) mkdirSync(EXPORTS_DIR, { recursive: true });
}

function fmtPct(n: number): string {
  return (n * 100).toFixed(2) + "%";
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function renderOverview(tweets: TweetWithEngagement[]): string {
  const totalImpressions = tweets.reduce((s, t) => s + t.metrics.impressions, 0);
  const totalLikes = tweets.reduce((s, t) => s + t.metrics.likes, 0);
  const totalReplies = tweets.reduce((s, t) => s + t.metrics.replies, 0);
  const totalRetweets = tweets.reduce((s, t) => s + t.metrics.retweets, 0);
  const rates = tweets.map(t => t.engagement_rate).filter(r => r > 0);
  const avgRate = rates.length > 0 ? rates.reduce((s, r) => s + r, 0) / rates.length : 0;
  const medRate = median(rates);

  let out = bold("Overview") + "\n";
  out += `  Tweets analyzed:    ${cyan(String(tweets.length))}\n`;
  out += `  Total impressions:  ${cyan(fmtNum(totalImpressions))}\n`;
  out += `  Total likes:        ${cyan(fmtNum(totalLikes))}\n`;
  out += `  Total replies:      ${cyan(fmtNum(totalReplies))}\n`;
  out += `  Total retweets:     ${cyan(fmtNum(totalRetweets))}\n`;
  out += `  Avg engagement:     ${yellow(fmtPct(avgRate))}\n`;
  out += `  Median engagement:  ${yellow(fmtPct(medRate))}\n`;
  return out;
}

function renderTopPerformers(tweets: TweetWithEngagement[]): string {
  const sorted = [...tweets].sort((a, b) => b.engagement_rate - a.engagement_rate);
  const top = sorted.slice(0, 5);

  let out = bold("Top Performers") + "\n";
  for (let i = 0; i < top.length; i++) {
    const t = top[i];
    const preview = t.text.replace(/https:\/\/t\.co\/\S+/g, "").trim().slice(0, 80);
    out += `  ${cyan(String(i + 1))}. ${yellow(fmtPct(t.engagement_rate))} engagement\n`;
    out += `     ${dim(preview)}${preview.length >= 80 ? "..." : ""}\n`;
    out += `     ${fmtNum(t.metrics.impressions)} imp | ${fmtNum(t.metrics.likes)} likes | ${fmtNum(t.metrics.retweets)} RT\n`;
    out += `     ${dim(t.tweet_url)}\n`;
  }
  return out;
}

function renderContentBreakdown(tweets: TweetWithEngagement[]): string {
  let threads = 0, media = 0, singles = 0;
  let threadEng = 0, mediaEng = 0, singleEng = 0;

  for (const t of tweets) {
    const hasMedia = (t.urls || []).some(u => u.url?.includes("pic.twitter.com")) ||
                     t.text.includes("pic.twitter.com");
    if (t.conversation_id === t.id) {
      threads++;
      threadEng += t.engagement_rate;
    } else if (hasMedia) {
      media++;
      mediaEng += t.engagement_rate;
    } else {
      singles++;
      singleEng += t.engagement_rate;
    }
  }

  let out = bold("Content Breakdown") + "\n";
  out += `  Threads:  ${cyan(String(threads))} tweets`;
  if (threads > 0) out += `  (avg ${yellow(fmtPct(threadEng / threads))} engagement)`;
  out += "\n";
  out += `  Media:    ${cyan(String(media))} tweets`;
  if (media > 0) out += `  (avg ${yellow(fmtPct(mediaEng / media))} engagement)`;
  out += "\n";
  out += `  Singles:  ${cyan(String(singles))} tweets`;
  if (singles > 0) out += `  (avg ${yellow(fmtPct(singleEng / singles))} engagement)`;
  out += "\n";
  return out;
}

function renderEngagementTrends(tweets: TweetWithEngagement[]): string {
  const sorted = [...tweets].sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (sorted.length < 2) return bold("Engagement Trends") + "\n  Not enough data\n";

  // Group by day
  const byDay = new Map<string, { rates: number[]; impressions: number }>();
  for (const t of sorted) {
    const day = t.created_at.slice(0, 10);
    const entry = byDay.get(day) || { rates: [], impressions: 0 };
    entry.rates.push(t.engagement_rate);
    entry.impressions += t.metrics.impressions;
    byDay.set(day, entry);
  }

  let out = bold("Engagement Trends") + "\n";
  for (const [day, data] of byDay) {
    const avg = data.rates.reduce((s, r) => s + r, 0) / data.rates.length;
    const bar = "█".repeat(Math.min(Math.round(avg * 500), 30));
    out += `  ${dim(day)} ${bar} ${yellow(fmtPct(avg))} (${data.rates.length} tweets, ${fmtNum(data.impressions)} imp)\n`;
  }
  return out;
}

function buildJsonOutput(tweets: TweetWithEngagement[]): object {
  const rates = tweets.map(t => t.engagement_rate).filter(r => r > 0);
  return {
    summary: {
      tweet_count: tweets.length,
      total_impressions: tweets.reduce((s, t) => s + t.metrics.impressions, 0),
      total_likes: tweets.reduce((s, t) => s + t.metrics.likes, 0),
      total_replies: tweets.reduce((s, t) => s + t.metrics.replies, 0),
      total_retweets: tweets.reduce((s, t) => s + t.metrics.retweets, 0),
      avg_engagement_rate: rates.length > 0 ? rates.reduce((s, r) => s + r, 0) / rates.length : 0,
      median_engagement_rate: median(rates),
    },
    top_performers: [...tweets]
      .sort((a, b) => b.engagement_rate - a.engagement_rate)
      .slice(0, 5)
      .map(t => ({
        id: t.id,
        text: t.text.slice(0, 200),
        engagement_rate: t.engagement_rate,
        metrics: t.metrics,
        tweet_url: t.tweet_url,
        created_at: t.created_at,
      })),
    tweets: tweets.map(t => ({
      id: t.id,
      text: t.text,
      engagement_rate: t.engagement_rate,
      metrics: t.metrics,
      tweet_url: t.tweet_url,
      created_at: t.created_at,
    })),
  };
}

export async function cmdAnalytics(args: string[]): Promise<void> {
  let since = "7d";
  let asJson = false;
  let save = false;
  let pages = 3;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--since":
        since = args[++i] || "7d";
        break;
      case "--json":
        asJson = true;
        break;
      case "--save":
        save = true;
        break;
      case "--pages":
        pages = Math.min(parseInt(args[++i] || "3"), 10);
        break;
      case "--help":
      case "-h":
        printHelp();
        return;
      default:
        break;
    }
    i++;
  }

  let token: string;
  try {
    token = await getValidToken();
  } catch (e: any) {
    console.error("OAuth required for analytics. Run 'xint auth setup' first.");
    console.error(`Error: ${e.message}`);
    process.exit(1);
    return;
  }

  const tokens = loadTokens();
  if (!tokens?.user_id) {
    console.error("Could not determine user ID from stored tokens. Re-run 'xint auth setup'.");
    process.exit(1);
    return;
  }

  console.error(`Fetching your tweets (since ${since})...`);

  const tweets = await getUserTimeline(tokens.user_id, token, {
    since,
    pages,
    exclude: ["replies", "retweets"],
  });

  trackCost("analytics", "analytics", 1);

  if (tweets.length === 0) {
    console.error("No tweets found in the specified period.");
    return;
  }

  console.error(`Analyzing ${tweets.length} tweets...\n`);

  if (asJson) {
    const data = buildJsonOutput(tweets);
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(renderOverview(tweets));
    console.log(renderTopPerformers(tweets));
    console.log(renderContentBreakdown(tweets));
    console.log(renderEngagementTrends(tweets));
  }

  if (save) {
    ensureExportsDir();
    const date = new Date().toISOString().slice(0, 10);
    const path = join(EXPORTS_DIR, `analytics-${date}.json`);
    writeFileSync(path, JSON.stringify(buildJsonOutput(tweets), null, 2));
    console.error(`Saved to ${path}`);
  }
}

function printHelp(): void {
  console.log(`
Usage: xint analytics [options]

Analyze your account's tweet performance and engagement metrics.

Options:
  --since <dur>    Time period (default: 7d). e.g. 1d, 7d, 30d
  --pages <N>      Pages of tweets to fetch (default: 3, max 10)
  --json           Output as JSON
  --save           Save results to data/exports/analytics-{date}.json

Examples:
  xint analytics                     # Last 7 days
  xint analytics --since 30d         # Last 30 days
  xint analytics --json              # JSON output
  xint analytics --save              # Save to file
`);
}
