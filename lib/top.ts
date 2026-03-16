import { loadTokens, getValidToken } from "./oauth";
import { getUserTimeline, type TweetWithEngagement } from "./timeline";
import { bold, cyan, yellow, dim, green } from "./format";

type SortMetric = "likes" | "impressions" | "clicks" | "engagement_rate";
type ContentType = "thread" | "media" | "single";

function classifyTweet(t: TweetWithEngagement): ContentType {
  if (t.conversation_id === t.id) return "thread";
  const hasMedia = (t.urls || []).some(u => u.url?.includes("pic.twitter.com")) ||
                   t.text.includes("pic.twitter.com");
  if (hasMedia) return "media";
  return "single";
}

function getSortValue(t: TweetWithEngagement, metric: SortMetric): number {
  switch (metric) {
    case "likes": return t.metrics.likes;
    case "impressions": return t.metrics.impressions;
    case "clicks": return t.non_public_metrics?.url_link_clicks || 0;
    case "engagement_rate": return t.engagement_rate;
  }
}

function fmtPct(n: number): string {
  return (n * 100).toFixed(2) + "%";
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

export async function cmdTop(args: string[]): Promise<void> {
  let sortBy: SortMetric = "engagement_rate";
  let limit = 10;
  let since = "7d";
  let filterType: ContentType | undefined;
  let asJson = false;
  let pages = 3;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--by":
        sortBy = (args[++i] || "engagement_rate") as SortMetric;
        break;
      case "--limit":
        limit = parseInt(args[++i] || "10");
        break;
      case "--since":
        since = args[++i] || "7d";
        break;
      case "--type":
        filterType = (args[++i] || undefined) as ContentType | undefined;
        break;
      case "--json":
        asJson = true;
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
    console.error("OAuth required. Run 'xint auth setup' first.");
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

  let tweets = await getUserTimeline(tokens.user_id, token, {
    since,
    pages,
    exclude: ["replies", "retweets"],
  });

  if (filterType) {
    tweets = tweets.filter(t => classifyTweet(t) === filterType);
  }

  tweets.sort((a, b) => getSortValue(b, sortBy) - getSortValue(a, sortBy));
  const top = tweets.slice(0, limit);

  if (top.length === 0) {
    console.error("No tweets found in the specified period.");
    return;
  }

  console.error(`Found ${tweets.length} tweets, showing top ${top.length} by ${sortBy}\n`);

  if (asJson) {
    console.log(JSON.stringify(top.map(t => ({
      id: t.id,
      text: t.text,
      type: classifyTweet(t),
      engagement_rate: t.engagement_rate,
      metrics: t.metrics,
      tweet_url: t.tweet_url,
      created_at: t.created_at,
    })), null, 2));
    return;
  }

  console.log(bold(`Top ${top.length} Tweets by ${sortBy}`) + "\n");
  for (let j = 0; j < top.length; j++) {
    const t = top[j];
    const preview = t.text.replace(/https:\/\/t\.co\/\S+/g, "").trim().slice(0, 100);
    const type = classifyTweet(t);
    const typeLabel = type === "thread" ? "[thread]" : type === "media" ? "[media]" : "[single]";

    console.log(`${cyan(String(j + 1))}. ${dim(typeLabel)} ${yellow(fmtPct(t.engagement_rate))} engagement`);
    console.log(`   ${preview}${preview.length >= 100 ? "..." : ""}`);
    console.log(`   ${fmtNum(t.metrics.impressions)} imp | ${fmtNum(t.metrics.likes)} likes | ${fmtNum(t.metrics.retweets)} RT | ${fmtNum(t.metrics.replies)} replies`);
    console.log(`   ${dim(t.tweet_url)}`);
    console.log();
  }
}

function printHelp(): void {
  console.log(`
Usage: xint top [options]

Show your top-performing tweets ranked by engagement metrics.

Options:
  --by <metric>     Sort by: likes, impressions, clicks, engagement_rate (default)
  --limit <N>       Number of tweets to show (default: 10)
  --since <dur>     Time period (default: 7d). e.g. 1d, 7d, 30d
  --type <type>     Filter by content type: thread, media, single
  --pages <N>       Pages of tweets to fetch (default: 3, max 10)
  --json            Output as JSON

Examples:
  xint top                           # Top 10 by engagement rate
  xint top --by likes --limit 20     # Top 20 by likes
  xint top --type media --since 30d  # Top media tweets, last 30 days
  xint top --json                    # JSON output
`);
}
