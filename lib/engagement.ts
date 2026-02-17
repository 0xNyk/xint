/**
 * engagement.ts — OAuth-authenticated engagement commands for xint CLI.
 * Liked tweets, like/unlike, following list, bookmark save/remove.
 */

import { BASE, FIELDS, oauthGet, oauthPost, oauthDelete, parseTweets, sleep, sortBy, dedupe } from "./api";
import type { Tweet } from "./api";
import { getValidToken, loadTokens } from "./oauth";
import { parseSince } from "./api";
import { trackCost } from "./costs";
import * as fmt from "./format";
import * as cache from "./cache";

// ── Liked Tweets ───────────────────────────────────────────────────────

export async function fetchLikedTweets(
  userId: string,
  accessToken: string,
  maxTotal: number = 200,
): Promise<Tweet[]> {
  const all: Tweet[] = [];
  let nextToken: string | undefined;

  while (all.length < maxTotal) {
    const perPage = Math.min(100, maxTotal - all.length);
    let url = `${BASE}/users/${userId}/liked_tweets?max_results=${perPage}&${FIELDS}`;
    if (nextToken) url += `&pagination_token=${nextToken}`;

    const raw = await oauthGet(url, accessToken);
    const tweets = parseTweets(raw);
    if (tweets.length === 0) break;

    all.push(...tweets);
    nextToken = raw?.meta?.next_token;
    if (!nextToken) break;
  }

  return dedupe(all).slice(0, maxTotal);
}

export async function cmdLikes(args: string[]): Promise<void> {
  let limit = 20;
  let since: string | undefined;
  let query: string | undefined;
  let json = false;
  let markdown = false;
  let noCache = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--limit":
        limit = parseInt(args[++i]) || 20;
        break;
      case "--since":
        since = args[++i];
        break;
      case "--query":
        query = args[++i];
        break;
      case "--json":
        json = true;
        break;
      case "--markdown":
        markdown = true;
        break;
      case "--no-cache":
        noCache = true;
        break;
    }
  }

  const tokens = loadTokens();
  if (!tokens) throw new Error("Not authenticated. Run 'auth setup' first.");
  const userId = tokens.user_id;
  const username = tokens.username;

  const cacheKey = `likes:${userId}`;
  const cacheTTL = 5 * 60 * 1000; // 5 min

  let tweets: Tweet[] | null = null;
  if (!noCache) {
    tweets = cache.get(cacheKey, "", cacheTTL);
  }

  if (!tweets) {
    const accessToken = await getValidToken();
    tweets = await fetchLikedTweets(userId, accessToken, Math.max(limit, 100));
    trackCost("likes", `/2/users/me/liked_tweets`, tweets.length);
    cache.set(cacheKey, "", tweets);
  }

  // Filter by since duration
  if (since) {
    const sinceTs = parseSince(since);
    if (sinceTs) {
      const sinceMs = new Date(sinceTs).getTime();
      tweets = tweets.filter((t) => {
        if (!t.created_at) return true;
        return new Date(t.created_at).getTime() >= sinceMs;
      });
    }
  }

  // Filter by query text
  if (query) {
    const q = query.toLowerCase();
    tweets = tweets.filter(
      (t) =>
        t.text.toLowerCase().includes(q) ||
        (t.username && t.username.toLowerCase().includes(q)) ||
        (t.name && t.name.toLowerCase().includes(q)),
    );
  }

  tweets = tweets.slice(0, limit);

  if (json) {
    console.log(JSON.stringify(tweets, null, 2));
    return;
  }

  if (markdown) {
    console.log(formatResultsTelegram(tweets, { query: query || "liked tweets", limit }));
    return;
  }

  console.log(`\n\u2764\uFE0F Liked Tweets \u2014 @${username}\n`);
  if (tweets.length === 0) {
    console.log("No liked tweets found.");
    return;
  }

  for (let i = 0; i < tweets.length; i++) {
    const t = tweets[i];
    const metrics = formatMetricsCompact(t);
    const age = t.created_at ? timeAgo(new Date(t.created_at)) : "";
    console.log(`${i + 1}. @${t.username || t.author_id} (${metrics}${age ? ` \u00B7 ${age}` : ""})`);
    console.log(`   ${t.text.slice(0, 280)}`);
    if (t.tweet_url) console.log(`   ${t.tweet_url}`);
    console.log();
  }

  console.error(`\n\uD83D\uDCD1 showing ${tweets.length} liked tweets`);
}

// ── Like / Unlike ──────────────────────────────────────────────────────

export async function likeTweet(
  userId: string,
  tweetId: string,
  accessToken: string,
): Promise<boolean> {
  const url = `${BASE}/users/${userId}/likes`;
  const result = await oauthPost(url, accessToken, { tweet_id: tweetId });
  return result?.data?.liked === true;
}

export async function cmdLike(args: string[]): Promise<void> {
  const tweetId = args.find((a) => !a.startsWith("-"));
  if (!tweetId) {
    console.error("Usage: like <tweet_id>");
    process.exit(1);
  }

  const tokens = loadTokens();
  if (!tokens) throw new Error("Not authenticated. Run 'auth setup' first.");

  const accessToken = await getValidToken();
  const ok = await likeTweet(tokens.user_id, tweetId, accessToken);

  if (ok) {
    console.log(`\u2705 Liked tweet ${tweetId}`);
    console.log(`   https://x.com/i/status/${tweetId}`);
  } else {
    console.error(`Failed to like tweet ${tweetId}`);
  }
}

export async function unlikeTweet(
  userId: string,
  tweetId: string,
  accessToken: string,
): Promise<boolean> {
  const url = `${BASE}/users/${userId}/likes/${tweetId}`;
  const result = await oauthDelete(url, accessToken);
  return result?.data?.liked === false || result?.success === true;
}

export async function cmdUnlike(args: string[]): Promise<void> {
  const tweetId = args.find((a) => !a.startsWith("-"));
  if (!tweetId) {
    console.error("Usage: unlike <tweet_id>");
    process.exit(1);
  }

  const tokens = loadTokens();
  if (!tokens) throw new Error("Not authenticated. Run 'auth setup' first.");

  const accessToken = await getValidToken();
  const ok = await unlikeTweet(tokens.user_id, tweetId, accessToken);

  if (ok) {
    console.log(`\u2705 Unliked tweet ${tweetId}`);
  } else {
    console.error(`Failed to unlike tweet ${tweetId}`);
  }
}

// ── Following ──────────────────────────────────────────────────────────

interface UserProfile {
  id: string;
  username: string;
  name: string;
  description?: string;
  public_metrics?: {
    followers_count: number;
    following_count: number;
    tweet_count: number;
  };
  created_at?: string;
}

export async function fetchFollowing(
  userId: string,
  accessToken: string,
  maxTotal: number = 500,
): Promise<UserProfile[]> {
  const all: UserProfile[] = [];
  let nextToken: string | undefined;
  const fields = "user.fields=username,name,public_metrics,description,created_at";

  while (all.length < maxTotal) {
    const perPage = Math.min(1000, maxTotal - all.length);
    let url = `${BASE}/users/${userId}/following?max_results=${perPage}&${fields}`;
    if (nextToken) url += `&pagination_token=${nextToken}`;

    const raw = await oauthGet(url, accessToken);
    const users: UserProfile[] = raw?.data || [];
    if (users.length === 0) break;

    all.push(...users);
    nextToken = raw?.meta?.next_token;
    if (!nextToken) break;
  }

  return all.slice(0, maxTotal);
}

export async function cmdFollowing(args: string[]): Promise<void> {
  let limit = 50;
  let json = false;
  let targetUsername: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit") {
      limit = parseInt(args[++i]) || 50;
    } else if (args[i] === "--json") {
      json = true;
    } else if (!args[i].startsWith("-")) {
      targetUsername = args[i].replace(/^@/, "");
    }
  }

  const tokens = loadTokens();
  if (!tokens) throw new Error("Not authenticated. Run 'auth setup' first.");

  const accessToken = await getValidToken();
  let userId = tokens.user_id;
  let displayUsername = tokens.username;

  // Look up another user's ID if a username was provided
  if (targetUsername && targetUsername.toLowerCase() !== tokens.username.toLowerCase()) {
    const lookupUrl = `${BASE}/users/by/username/${targetUsername}?user.fields=public_metrics`;
    const lookupResult = await oauthGet(lookupUrl, accessToken);
    if (!lookupResult?.data?.id) {
      throw new Error(`User @${targetUsername} not found`);
    }
    userId = lookupResult.data.id;
    displayUsername = targetUsername;
  }

  const users = await fetchFollowing(userId, accessToken, limit);

  if (json) {
    console.log(JSON.stringify(users, null, 2));
    return;
  }

  console.log(`\n\uD83D\uDC65 Following \u2014 @${displayUsername} (${users.length} accounts)\n`);

  if (users.length === 0) {
    console.log("Not following anyone.");
    return;
  }

  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const followers = u.public_metrics?.followers_count;
    const followerStr = followers !== undefined ? formatCount(followers) + " followers" : "";
    console.log(`${i + 1}. @${u.username} \u2014 ${u.name}${followerStr ? ` (${followerStr})` : ""}`);
    if (u.description) {
      console.log(`   ${u.description.slice(0, 200).replace(/\n/g, " ")}`);
    }
  }
}

// ── Follow / Unfollow (write) ─────────────────────────────────────────

function isLikelyUserId(input: string): boolean {
  return /^\d+$/.test(input);
}

async function resolveTargetUser(input: string, accessToken: string): Promise<{ id: string; username: string }> {
  const value = input.replace(/^@/, "");
  if (isLikelyUserId(value)) {
    return { id: value, username: value };
  }

  const lookupUrl = `${BASE}/users/by/username/${value}?user.fields=public_metrics`;
  const lookupResult = await oauthGet(lookupUrl, accessToken);
  if (!lookupResult?.data?.id) {
    throw new Error(`User @${value} not found`);
  }
  return { id: lookupResult.data.id, username: lookupResult.data.username || value };
}

export async function followUser(
  sourceUserId: string,
  targetUserId: string,
  accessToken: string,
): Promise<boolean> {
  const url = `${BASE}/users/${sourceUserId}/following`;
  const result = await oauthPost(url, accessToken, { target_user_id: targetUserId });
  return result?.data?.following === true || result?.success === true;
}

export async function cmdFollow(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: follow <@username|user_id> [--json]");
    return;
  }
  const target = args.find((a) => !a.startsWith("-"));
  const asJson = args.includes("--json");
  if (!target) {
    console.error("Usage: follow <@username|user_id> [--json]");
    process.exit(1);
  }

  const tokens = loadTokens();
  if (!tokens) throw new Error("Not authenticated. Run 'auth setup' first.");

  const accessToken = await getValidToken();
  const resolved = await resolveTargetUser(target, accessToken);
  const ok = await followUser(tokens.user_id, resolved.id, accessToken);
  trackCost("follow", `/2/users/${tokens.user_id}/following`, 0);

  if (asJson) {
    console.log(JSON.stringify({ success: ok, user_id: resolved.id, username: resolved.username }, null, 2));
    return;
  }

  if (ok) {
    console.log(`✅ Following @${resolved.username}`);
  } else {
    console.error(`Failed to follow @${resolved.username}`);
  }
}

export async function unfollowUser(
  sourceUserId: string,
  targetUserId: string,
  accessToken: string,
): Promise<boolean> {
  const url = `${BASE}/users/${sourceUserId}/following/${targetUserId}`;
  const result = await oauthDelete(url, accessToken);
  return result?.data?.following === false || result?.success === true;
}

export async function cmdUnfollow(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: unfollow <@username|user_id> [--json]");
    return;
  }
  const target = args.find((a) => !a.startsWith("-"));
  const asJson = args.includes("--json");
  if (!target) {
    console.error("Usage: unfollow <@username|user_id> [--json]");
    process.exit(1);
  }

  const tokens = loadTokens();
  if (!tokens) throw new Error("Not authenticated. Run 'auth setup' first.");

  const accessToken = await getValidToken();
  const resolved = await resolveTargetUser(target, accessToken);
  const ok = await unfollowUser(tokens.user_id, resolved.id, accessToken);
  trackCost("unfollow", `/2/users/${tokens.user_id}/following`, 0);

  if (asJson) {
    console.log(JSON.stringify({ success: ok, user_id: resolved.id, username: resolved.username }, null, 2));
    return;
  }

  if (ok) {
    console.log(`✅ Unfollowed @${resolved.username}`);
  } else {
    console.error(`Failed to unfollow @${resolved.username}`);
  }
}

// ── Bookmarks (save / remove) ──────────────────────────────────────────

export async function bookmarkTweet(
  userId: string,
  tweetId: string,
  accessToken: string,
): Promise<boolean> {
  const url = `${BASE}/users/${userId}/bookmarks`;
  const result = await oauthPost(url, accessToken, { tweet_id: tweetId });
  return result?.data?.bookmarked === true;
}

export async function cmdBookmarkSave(args: string[]): Promise<void> {
  const tweetId = args.find((a) => !a.startsWith("-"));
  if (!tweetId) {
    console.error("Usage: bookmark <tweet_id>");
    process.exit(1);
  }

  const tokens = loadTokens();
  if (!tokens) throw new Error("Not authenticated. Run 'auth setup' first.");

  const accessToken = await getValidToken();
  const ok = await bookmarkTweet(tokens.user_id, tweetId, accessToken);

  if (ok) {
    console.log(`\uD83D\uDD16 Bookmarked tweet ${tweetId}`);
    console.log(`   https://x.com/i/status/${tweetId}`);
  } else {
    console.error(`Failed to bookmark tweet ${tweetId}`);
  }
}

export async function unbookmarkTweet(
  userId: string,
  tweetId: string,
  accessToken: string,
): Promise<boolean> {
  const url = `${BASE}/users/${userId}/bookmarks/${tweetId}`;
  const result = await oauthDelete(url, accessToken);
  return result?.data?.bookmarked === false || result?.success === true;
}

export async function cmdUnbookmark(args: string[]): Promise<void> {
  const tweetId = args.find((a) => !a.startsWith("-"));
  if (!tweetId) {
    console.error("Usage: unbookmark <tweet_id>");
    process.exit(1);
  }

  const tokens = loadTokens();
  if (!tokens) throw new Error("Not authenticated. Run 'auth setup' first.");

  const accessToken = await getValidToken();
  const ok = await unbookmarkTweet(tokens.user_id, tweetId, accessToken);

  if (ok) {
    console.log(`\u2705 Removed bookmark for tweet ${tweetId}`);
  } else {
    console.error(`Failed to remove bookmark for tweet ${tweetId}`);
  }
}

// ── Utility helpers ────────────────────────────────────────────────────

function timeAgo(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function formatMetricsCompact(t: Tweet): string {
  const parts: string[] = [];
  if (t.metrics?.likes !== undefined) parts.push(`${formatCount(t.metrics.likes)}\u2764\uFE0F`);
  if (t.metrics?.impressions !== undefined) parts.push(`${formatCount(t.metrics.impressions)}\uD83D\uDC41`);
  return parts.join(" ");
}

function formatResultsTelegram(tweets: Tweet[], opts: { query: string; limit: number }): string {
  return fmt.formatResultsTelegram(tweets, opts);
}
