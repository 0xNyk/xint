/**
 * lib/users.ts — Search for X users by query.
 *
 * GET /2/users/search?query=<query>&max_results=N
 */

import { BASE, bearerGet } from "./api";
import { trackCost } from "./costs";

interface SearchUser {
  id: string;
  username: string;
  name: string;
  description?: string;
  created_at?: string;
  public_metrics?: {
    followers_count: number;
    following_count: number;
    tweet_count: number;
  };
}

const USER_FIELDS = "user.fields=id,username,name,public_metrics,description,created_at";

export async function cmdUsers(args: string[]): Promise<void> {
  let limit = 20;
  let json = false;
  const queryParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--limit":
        limit = Math.max(1, Math.min(100, parseInt(args[++i]) || 20));
        break;
      case "--json":
        json = true;
        break;
      case "--help":
      case "-h":
        printUsersHelp();
        return;
      default:
        if (!arg.startsWith("-")) queryParts.push(arg);
    }
  }

  const query = queryParts.join(" ").trim();
  if (!query) {
    printUsersHelp();
    return;
  }

  const encoded = encodeURIComponent(query);
  const url = `${BASE}/users/search?query=${encoded}&max_results=${limit}&${USER_FIELDS}`;
  const raw = await bearerGet(url);
  const users: SearchUser[] = (raw as any)?.data || [];

  trackCost("users_search", `/2/users/search`, users.length);

  if (json) {
    console.log(JSON.stringify(users, null, 2));
    return;
  }

  if (users.length === 0) {
    console.log(`No users found for "${query}".`);
    return;
  }

  console.log(`\n🔍 Users matching "${query}" (${users.length})\n`);

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

function printUsersHelp(): void {
  console.log(`Usage: xint users "<query>" [options]

Search for X users by name or username.

Options:
  --limit N     Max users to return (1-100, default: 20)
  --json        Output raw JSON

Examples:
  xint users "vitalik"
  xint users "AI researcher" --limit 50
  xint users "solana" --json`);
}
