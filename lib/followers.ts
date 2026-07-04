/**
 * lib/followers.ts — Follower/following tracking with diff snapshots.
 *
 * Fetches a user's followers or following list, stores local snapshots,
 * and computes diffs to show who followed/unfollowed over time.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { BASE, FIELDS, sleep, oauthGet } from "./api";
import { previewAndExit, estimateCost } from "./dryrun";
import { getValidToken } from "./oauth";
import { trackCost } from "./costs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserSnapshot {
  id: string;
  username: string;
  name: string;
  followers_count?: number;
  following_count?: number;
}

export interface Snapshot {
  username: string;
  type: "followers" | "following";
  timestamp: string;
  count: number;
  users: UserSnapshot[];
}

export interface FollowerDiff {
  added: UserSnapshot[];
  removed: UserSnapshot[];
  unchanged: number;
  previous: { timestamp: string; count: number };
  current: { timestamp: string; count: number };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILL_DIR = import.meta.dir;
const SNAPSHOTS_DIR = join(SKILL_DIR, "..", "data", "snapshots");

// ---------------------------------------------------------------------------
// Snapshot storage
// ---------------------------------------------------------------------------

function ensureDir(): void {
  if (!existsSync(SNAPSHOTS_DIR)) mkdirSync(SNAPSHOTS_DIR, { recursive: true });
}

function snapshotPath(username: string, type: string, date: string): string {
  // Usernames come from CLI args — sanitize so a crafted value can't
  // traverse outside data/snapshots/ (same guard as report.ts/media.ts).
  const safe = username.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return join(SNAPSHOTS_DIR, `${safe}-${type}-${date}.json`);
}

function saveSnapshot(snap: Snapshot): string {
  ensureDir();
  const date = snap.timestamp.slice(0, 10);
  const path = snapshotPath(snap.username, snap.type, date);
  writeFileSync(path, JSON.stringify(snap, null, 2));
  return path;
}

function loadLatestSnapshot(username: string, type: string): Snapshot | null {
  ensureDir();
  const prefix = `${username.toLowerCase()}-${type}-`;
  const files = readdirSync(SNAPSHOTS_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith(".json"))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  try {
    return JSON.parse(readFileSync(join(SNAPSHOTS_DIR, files[0]), "utf-8"));
  } catch {
    return null;
  }
}

function listSnapshots(username: string, type: string): string[] {
  ensureDir();
  const prefix = `${username.toLowerCase()}-${type}-`;
  return readdirSync(SNAPSHOTS_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith(".json"))
    .sort()
    .reverse();
}

// Followers/following are paid per-user ($0.01 each). A single diff against
// 5000 followers costs $50. Re-running within 24h almost always returns the
// same list — so we treat the most recent snapshot as a cache when it's
// fresh enough. `--fresh` bypasses the cache to force a live fetch.
const DEFAULT_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Return the most recent snapshot if it's still within the TTL window.
 * Returns null if no snapshot exists or it's too old. Reading a snapshot
 * costs $0 (local file); fetching costs ~$0.01 × followers count.
 */
export function loadFreshSnapshot(
  username: string,
  type: "followers" | "following",
  ttlMs: number = DEFAULT_SNAPSHOT_TTL_MS,
): Snapshot | null {
  const snap = loadLatestSnapshot(username, type);
  if (!snap) return null;
  const age = Date.now() - new Date(snap.timestamp).getTime();
  if (age > ttlMs) return null;
  return snap;
}

// ---------------------------------------------------------------------------
// API fetching
// ---------------------------------------------------------------------------

async function lookupUserId(username: string, accessToken: string): Promise<string> {
  const url = `${BASE}/users/by/username/${username}?user.fields=public_metrics`;
  const raw = await oauthGet(url, accessToken);
  const data = (raw as any).data;
  if (!data?.id) throw new Error(`User @${username} not found`);
  return data.id;
}

async function fetchFollowers(
  userId: string,
  accessToken: string,
  maxPages: number = 5
): Promise<UserSnapshot[]> {
  const users: UserSnapshot[] = [];
  let nextToken: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const pagination = nextToken ? `&pagination_token=${nextToken}` : "";
    const url = `${BASE}/users/${userId}/followers?max_results=1000&user.fields=public_metrics,username,name${pagination}`;
    const raw = await oauthGet(url, accessToken);

    const data = (raw as any).data || [];
    for (const u of data) {
      users.push({
        id: u.id,
        username: u.username,
        name: u.name,
        followers_count: u.public_metrics?.followers_count,
        following_count: u.public_metrics?.following_count,
      });
    }

    nextToken = (raw as any).meta?.next_token;
    if (!nextToken) break;
    await sleep(350);
  }

  return users;
}

async function fetchFollowing(
  userId: string,
  accessToken: string,
  maxPages: number = 5
): Promise<UserSnapshot[]> {
  const users: UserSnapshot[] = [];
  let nextToken: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const pagination = nextToken ? `&pagination_token=${nextToken}` : "";
    const url = `${BASE}/users/${userId}/following?max_results=1000&user.fields=public_metrics,username,name${pagination}`;
    const raw = await oauthGet(url, accessToken);

    const data = (raw as any).data || [];
    for (const u of data) {
      users.push({
        id: u.id,
        username: u.username,
        name: u.name,
        followers_count: u.public_metrics?.followers_count,
        following_count: u.public_metrics?.following_count,
      });
    }

    nextToken = (raw as any).meta?.next_token;
    if (!nextToken) break;
    await sleep(350);
  }

  return users;
}

// ---------------------------------------------------------------------------
// Diff computation
// ---------------------------------------------------------------------------

function computeDiff(previous: Snapshot, current: Snapshot): FollowerDiff {
  const prevIds = new Set(previous.users.map(u => u.id));
  const currIds = new Set(current.users.map(u => u.id));

  const added = current.users.filter(u => !prevIds.has(u.id));
  const removed = previous.users.filter(u => !currIds.has(u.id));
  const unchanged = current.users.filter(u => prevIds.has(u.id)).length;

  return {
    added,
    removed,
    unchanged,
    previous: { timestamp: previous.timestamp, count: previous.count },
    current: { timestamp: current.timestamp, count: current.count },
  };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function formatDiff(diff: FollowerDiff, type: string): string {
  const netChange = diff.added.length - diff.removed.length;
  const sign = netChange >= 0 ? "+" : "";
  const prevDate = diff.previous.timestamp.slice(0, 10);
  const currDate = diff.current.timestamp.slice(0, 10);

  let out = `\n${type === "followers" ? "Follower" : "Following"} Diff: ${prevDate} -> ${currDate}\n`;
  out += `${diff.previous.count} -> ${diff.current.count} (${sign}${netChange} net)\n`;

  if (diff.added.length > 0) {
    out += `\n+ New (${diff.added.length}):\n`;
    for (const u of diff.added.slice(0, 50)) {
      const followers = u.followers_count !== undefined ? ` (${u.followers_count} followers)` : "";
      out += `  + @${u.username}${followers}\n`;
    }
    if (diff.added.length > 50) out += `  ... +${diff.added.length - 50} more\n`;
  }

  if (diff.removed.length > 0) {
    out += `\n- Lost (${diff.removed.length}):\n`;
    for (const u of diff.removed.slice(0, 50)) {
      out += `  - @${u.username}\n`;
    }
    if (diff.removed.length > 50) out += `  ... +${diff.removed.length - 50} more\n`;
  }

  if (diff.added.length === 0 && diff.removed.length === 0) {
    out += `\nNo changes detected.\n`;
  }

  return out;
}

// ---------------------------------------------------------------------------
// CLI handler
// ---------------------------------------------------------------------------

export async function cmdDiff(args: string[]): Promise<void> {
  let username: string | undefined;
  let type: "followers" | "following" = "followers";
  let showHistory = false;
  let asJson = false;
  let maxPages = 5;
  let fresh = false;
  let dryRun = false;

  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--following":
        type = "following";
        break;
      case "--history":
        showHistory = true;
        break;
      case "--json":
        asJson = true;
        break;
      case "--pages":
        maxPages = Math.min(parseInt(args[++i] || "5"), 15);
        break;
      case "--fresh":
        // Force a live fetch even if we have a recent snapshot.
        fresh = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--help":
      case "-h":
        printDiffHelp();
        return;
      default:
        positional.push(arg);
    }
    i++;
  }

  username = positional[0]?.replace(/^@/, "");
  if (!username) {
    printDiffHelp();
    return;
  }

  // Dry-run preview — emit BEFORE OAuth so users can preview cost without
  // a valid token. Max cost is maxPages × 1000 × $0.01 = up to $50.
  if (dryRun) {
    const maxUnits = maxPages * 1000;
    const cached = !fresh && loadFreshSnapshot(username, type) !== null;
    previewAndExit({
      command: `diff @${username} (${type})`,
      endpoint: `/2/users/{id}/${type}`,
      units: maxUnits,
      unitLabel: "users",
      costUsd: estimateCost(type === "followers" ? "followers" : "following", maxUnits),
      cachePredictedHit: cached,
      cacheTtlMinutes: 24 * 60,
      notes: [
        cached
          ? "Snapshot cache HIT predicted — real cost likely $0 (pass --fresh to bypass)."
          : "No fresh snapshot found — full fetch will happen.",
        "Max cost reached only if the account has 5000+ followers.",
        "Requires OAuth at runtime (xint auth setup).",
      ],
    });
  }

  // Show snapshot history
  if (showHistory) {
    const files = listSnapshots(username, type);
    if (files.length === 0) {
      console.log(`No ${type} snapshots for @${username}. Run 'xint diff @${username}' to create one.`);
      return;
    }
    console.log(`\nSnapshots for @${username} (${type}):\n`);
    for (const f of files) {
      try {
        const snap: Snapshot = JSON.parse(readFileSync(join(SNAPSHOTS_DIR, f), "utf-8"));
        console.log(`  ${snap.timestamp.slice(0, 10)} — ${snap.count} ${type}`);
      } catch {
        console.log(`  ${f} (corrupted)`);
      }
    }
    return;
  }

  // Get OAuth token
  let token: string;
  try {
    token = await getValidToken();
  } catch (e: any) {
    console.error(`OAuth required for follower tracking. Run 'xint auth setup' first.`);
    console.error(`Error: ${e.message}`);
    process.exit(1);
    return; // unreachable, makes TS happy
  }

  // Try to serve from cache first — a 5000-follower fetch costs ~$50, but
  // followers rarely change minute-to-minute. Reuse a snapshot <24h old
  // unless --fresh was passed.
  let users: UserSnapshot[];
  let cacheHit = false;
  if (!fresh) {
    const cached = loadFreshSnapshot(username, type);
    if (cached) {
      const ageHours = ((Date.now() - new Date(cached.timestamp).getTime()) / 3_600_000).toFixed(1);
      console.error(`(cache hit — ${cached.users.length} ${type}, ${ageHours}h old; pass --fresh to force re-fetch)`);
      users = cached.users;
      cacheHit = true;
    } else {
      console.error(`Fetching ${type} for @${username}...`);
      const userId = await lookupUserId(username, token);
      trackCost("profile", `/2/users/by/username/${username}`, 1);
      users = type === "followers"
        ? await fetchFollowers(userId, token, maxPages)
        : await fetchFollowing(userId, token, maxPages);
      trackCost(type === "followers" ? "followers" : "following", `/2/users/${userId}/${type}`, users.length);
    }
  } else {
    console.error(`Fetching ${type} for @${username} (--fresh, bypassing cache)...`);
    const userId = await lookupUserId(username, token);
    trackCost("profile", `/2/users/by/username/${username}`, 1);
    users = type === "followers"
      ? await fetchFollowers(userId, token, maxPages)
      : await fetchFollowing(userId, token, maxPages);
    trackCost(type === "followers" ? "followers" : "following", `/2/users/${userId}/${type}`, users.length);
  }

  if (!cacheHit) console.error(`Found ${users.length} ${type}`);

  // Create current snapshot
  const current: Snapshot = {
    username,
    type,
    timestamp: new Date().toISOString(),
    count: users.length,
    users,
  };

  // Load previous snapshot for diff
  const previous = loadLatestSnapshot(username, type);

  // Save current snapshot
  const savePath = saveSnapshot(current);
  console.error(`Snapshot saved to ${savePath}`);

  // Compute and display diff
  if (previous) {
    const diff = computeDiff(previous, current);

    if (asJson) {
      console.log(JSON.stringify(diff, null, 2));
    } else {
      console.log(formatDiff(diff, type));
    }
  } else {
    console.log(`\nFirst snapshot for @${username} (${type}): ${users.length} users`);
    console.log(`Run again later to see changes.`);

    if (asJson) {
      console.log(JSON.stringify(current, null, 2));
    } else {
      // Show top followers by follower count
      const sorted = [...users].sort((a, b) => (b.followers_count || 0) - (a.followers_count || 0));
      const top = sorted.slice(0, 20);
      console.log(`\nTop ${type} by follower count:\n`);
      for (const u of top) {
        const fc = u.followers_count !== undefined ? `${u.followers_count} followers` : "";
        console.log(`  @${u.username} — ${u.name} (${fc})`);
      }
    }
  }
}

function printDiffHelp(): void {
  console.log(`
Usage: xint diff <@username> [options]

Track follower/following changes over time. Creates local snapshots
and shows diffs between the latest and previous snapshots.

Options:
  --following     Track following list instead of followers
  --history       Show all saved snapshots for this user
  --pages <N>     Max pages to fetch, 1-15 (default: 5, ~5000 users)
  --json          Output diff as JSON

Examples:
  xint diff @vitalikbuterin              # snapshot + diff followers
  xint diff @0xNyk --following            # track following changes
  xint diff @elonmusk --history           # list all snapshots
  xint diff @solana_legend --json         # diff as structured JSON
`);
}
