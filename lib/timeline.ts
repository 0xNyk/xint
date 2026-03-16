import { BASE, oauthGet, parseTweets, parseSince, sleep, type Tweet } from "./api";
import { trackCost } from "./costs";

const RATE_DELAY_MS = 350;

const TIMELINE_FIELDS =
  "tweet.fields=created_at,public_metrics,non_public_metrics,organic_metrics,entities,note_tweet&expansions=author_id&user.fields=username,name,public_metrics";

export interface TimelineOpts {
  maxResults?: number;
  pages?: number;
  exclude?: string[];  // "replies", "retweets"
  since?: string;      // shorthand like "7d" or ISO timestamp
}

export interface TweetWithEngagement extends Tweet {
  engagement_rate: number;
}

function calcEngagementRate(t: Tweet): number {
  const m = t.metrics;
  if (!m.impressions || m.impressions === 0) return 0;
  return (m.likes + m.replies + m.retweets + m.quotes) / m.impressions;
}

export async function getUserTimeline(
  userId: string,
  accessToken: string,
  opts: TimelineOpts = {},
): Promise<TweetWithEngagement[]> {
  const maxResults = Math.min(Math.max(opts.maxResults || 100, 5), 100);
  const pages = opts.pages || 1;
  const exclude = opts.exclude || ["replies", "retweets"];

  let timeFilter = "";
  if (opts.since) {
    const startTime = parseSince(opts.since);
    if (startTime) timeFilter = `&start_time=${startTime}`;
  }

  const excludeParam = exclude.length > 0 ? `&exclude=${exclude.join(",")}` : "";
  const allTweets: TweetWithEngagement[] = [];
  let nextToken: string | undefined;

  for (let page = 0; page < pages; page++) {
    const pagination = nextToken ? `&pagination_token=${nextToken}` : "";
    const url = `${BASE}/users/${userId}/tweets?max_results=${maxResults}&${TIMELINE_FIELDS}${excludeParam}${timeFilter}${pagination}`;

    const raw = await oauthGet(url, accessToken);
    const tweets = parseTweets(raw);
    trackCost("timeline", `/2/users/${userId}/tweets`, tweets.length);

    for (const t of tweets) {
      allTweets.push({ ...t, engagement_rate: calcEngagementRate(t) });
    }

    nextToken = (raw as any).meta?.next_token;
    if (!nextToken) break;
    if (page < pages - 1) await sleep(RATE_DELAY_MS);
  }

  return allTweets;
}
