/**
 * lib/reposts.ts — Fetch users who reposted (retweeted) a tweet.
 *
 * GET /2/tweets/:id/retweets — returns users who reposted.
 */

import { BASE, bearerGet, sleep } from "./api";
import { trackCost } from "./costs";

interface RepostUser {
  id: string;
  username: string;
  name: string;
  description?: string;
  public_metrics?: {
    followers_count: number;
    following_count: number;
    tweet_count: number;
  };
}

const USER_FIELDS = "user.fields=id,username,name,public_metrics,description";

async function fetchReposters(
  tweetId: string,
  maxTotal: number,
): Promise<RepostUser[]> {
  const all: RepostUser[] = [];
  let nextToken: string | undefined;

  while (all.length < maxTotal) {
    const perPage = Math.min(100, maxTotal - all.length);
    let url = `${BASE}/tweets/${tweetId}/retweets?max_results=${perPage}&${USER_FIELDS}`;
    if (nextToken) url += `&pagination_token=${nextToken}`;

    const raw = await bearerGet(url);
    const users: RepostUser[] = (raw as any)?.data || [];
    if (users.length === 0) break;

    all.push(...users);
    nextToken = (raw as any)?.meta?.next_token;
    if (!nextToken) break;
    await sleep(350);
  }

  return all.slice(0, maxTotal);
}

export async function cmdReposts(args: string[]): Promise<void> {
  let limit = 100;
  let json = false;
  let tweetId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--limit":
        limit = Math.max(1, parseInt(args[++i]) || 100);
        break;
      case "--json":
        json = true;
        break;
      case "--help":
      case "-h":
        printRepostsHelp();
        return;
      default:
        if (!arg.startsWith("-")) tweetId = arg;
    }
  }

  if (!tweetId) {
    printRepostsHelp();
    return;
  }

  const users = await fetchReposters(tweetId, limit);
  trackCost("reposts", `/2/tweets/${tweetId}/retweets`, users.length);

  if (json) {
    console.log(JSON.stringify(users, null, 2));
    return;
  }

  if (users.length === 0) {
    console.log(`No reposts found for tweet ${tweetId}.`);
    return;
  }

  console.log(`\n🔁 Reposts — tweet ${tweetId} (${users.length} users)\n`);

  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const followers = u.public_metrics?.followers_count;
    const followerStr = followers !== undefined ? ` (${formatCount(followers)} followers)` : "";
    console.log(`${i + 1}. @${u.username} — ${u.name}${followerStr}`);
    if (u.description) {
      console.log(`   ${u.description.slice(0, 200).replace(/\n/g, " ")}`);
    }
  }
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function printRepostsHelp(): void {
  console.log(`Usage: xint reposts <tweet_id> [options]

List users who reposted (retweeted) a tweet.

Options:
  --limit N     Max users to fetch (default: 100)
  --json        Output raw JSON

Examples:
  xint reposts 1234567890
  xint reposts 1234567890 --limit 50 --json`);
}
