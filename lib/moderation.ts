/**
 * moderation.ts — OAuth-authenticated block/mute management.
 * Supports list/add/remove for both blocked and muted users.
 */

import { BASE, oauthDelete, oauthGet, oauthPost } from "./api";
import { getValidToken, loadTokens } from "./oauth";
import { trackCost } from "./costs";

interface XUser {
  id: string;
  username: string;
  name?: string;
  description?: string;
  public_metrics?: {
    followers_count?: number;
  };
}

interface ModeConfig {
  noun: "blocks" | "mutes";
  path: "blocking" | "muting";
  listOp: "blocks_list" | "mutes_list";
  addOp: "blocks_add" | "mutes_add";
  removeOp: "blocks_remove" | "mutes_remove";
}

const USER_FIELDS = "user.fields=id,username,name,description,public_metrics";

export function isLikelyUserId(value: string): boolean {
  return /^\d+$/.test(value);
}

export function parseListFlags(args: string[]): { json: boolean; limit: number } {
  let json = false;
  let limit = 50;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--json":
        json = true;
        break;
      case "--limit": {
        const parsed = parseInt(args[++i] || "50", 10);
        limit = Math.max(1, Number.isNaN(parsed) ? 50 : parsed);
        break;
      }
    }
  }

  return { json, limit };
}

async function resolveUserId(input: string, accessToken: string): Promise<{ id: string; username: string }> {
  const value = input.replace(/^@/, "");
  if (isLikelyUserId(value)) {
    return { id: value, username: value };
  }

  const url = `${BASE}/users/by/username/${encodeURIComponent(value)}?${USER_FIELDS}`;
  const raw = await oauthGet(url, accessToken);
  const user = raw?.data;
  if (!user?.id) {
    throw new Error(`User not found: @${value}`);
  }
  return { id: user.id, username: user.username || value };
}

async function fetchUsers(
  userId: string,
  accessToken: string,
  cfg: ModeConfig,
  maxTotal: number,
): Promise<XUser[]> {
  const all: XUser[] = [];
  let nextToken: string | undefined;

  while (all.length < maxTotal) {
    const perPage = Math.min(100, maxTotal - all.length);
    let url = `${BASE}/users/${userId}/${cfg.path}?max_results=${perPage}&${USER_FIELDS}`;
    if (nextToken) url += `&pagination_token=${nextToken}`;

    const raw = await oauthGet(url, accessToken);
    const users: XUser[] = raw?.data || [];
    if (users.length === 0) break;

    all.push(...users);
    nextToken = raw?.meta?.next_token;
    if (!nextToken) break;
  }

  return all.slice(0, maxTotal);
}

async function addUser(userId: string, targetUserId: string, accessToken: string, cfg: ModeConfig): Promise<boolean> {
  const url = `${BASE}/users/${userId}/${cfg.path}`;
  const result = await oauthPost(url, accessToken, { target_user_id: targetUserId });
  return result?.data?.blocking === true || result?.data?.muting === true || result?.success === true;
}

async function removeUser(
  sourceUserId: string,
  targetUserId: string,
  accessToken: string,
  cfg: ModeConfig,
): Promise<boolean> {
  const url = `${BASE}/users/${sourceUserId}/${cfg.path}/${targetUserId}`;
  const result = await oauthDelete(url, accessToken);
  return result?.data?.blocking === false || result?.data?.muting === false || result?.success === true;
}

function usage(mode: "blocks" | "mutes"): void {
  console.log(`Usage: xint ${mode} <subcommand> [options]

Subcommands:
  list [--limit N] [--json]                 List your ${mode} (default)
  add <@username|user_id> [--json]          Add ${mode === "blocks" ? "block" : "mute"}
  remove <@username|user_id> [--json]       Remove ${mode === "blocks" ? "block" : "mute"}

Examples:
  xint ${mode}
  xint ${mode} add @example
  xint ${mode} remove 2244994945
  xint ${mode} list --limit 100 --json`);
}

async function runMode(mode: "blocks" | "mutes", rawArgs: string[]): Promise<void> {
  const cfg: ModeConfig =
    mode === "blocks"
      ? {
          noun: "blocks",
          path: "blocking",
          listOp: "blocks_list",
          addOp: "blocks_add",
          removeOp: "blocks_remove",
        }
      : {
          noun: "mutes",
          path: "muting",
          listOp: "mutes_list",
          addOp: "mutes_add",
          removeOp: "mutes_remove",
        };

  const sub = (rawArgs[0] || "list").toLowerCase();
  const args = rawArgs.slice(1);

  if (sub === "help" || sub === "--help" || sub === "-h") {
    usage(mode);
    return;
  }

  const tokens = loadTokens();
  if (!tokens) throw new Error("Not authenticated. Run 'auth setup' first.");
  const accessToken = await getValidToken();

  if (sub === "list" || sub === "ls") {
    const { json, limit } = parseListFlags(args);
    const users = await fetchUsers(tokens.user_id, accessToken, cfg, limit);
    trackCost(cfg.listOp, `/2/users/${tokens.user_id}/${cfg.path}`, users.length);

    if (json) {
      console.log(JSON.stringify(users, null, 2));
      return;
    }

    if (users.length === 0) {
      console.log(`No ${cfg.noun} found.`);
      return;
    }

    console.log(`\n🚫 ${cfg.noun[0].toUpperCase()}${cfg.noun.slice(1)} — @${tokens.username} (${users.length})\n`);
    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      const followers = u.public_metrics?.followers_count;
      const followerStr = followers !== undefined ? ` (${followers} followers)` : "";
      console.log(`${i + 1}. @${u.username}${u.name ? ` — ${u.name}` : ""}${followerStr}`);
      if (u.description) {
        console.log(`   ${u.description.slice(0, 180).replace(/\n/g, " ")}`);
      }
    }
    return;
  }

  if (sub === "add") {
    const target = args.find((a) => !a.startsWith("-"));
    const json = args.includes("--json");
    if (!target) throw new Error(`Usage: xint ${mode} add <@username|user_id>`);

    const resolved = await resolveUserId(target, accessToken);
    const ok = await addUser(tokens.user_id, resolved.id, accessToken, cfg);
    trackCost(cfg.addOp, `/2/users/${tokens.user_id}/${cfg.path}`, 0);

    if (json) {
      console.log(
        JSON.stringify({ success: ok, user_id: resolved.id, username: resolved.username, action: `${mode}_add` }, null, 2),
      );
      return;
    }

    console.log(
      ok
        ? `✅ ${mode === "blocks" ? "Blocked" : "Muted"} @${resolved.username}`
        : `Failed to ${mode === "blocks" ? "block" : "mute"} @${resolved.username}`,
    );
    return;
  }

  if (sub === "remove" || sub === "rm" || sub === "delete") {
    const target = args.find((a) => !a.startsWith("-"));
    const json = args.includes("--json");
    if (!target) throw new Error(`Usage: xint ${mode} remove <@username|user_id>`);

    const resolved = await resolveUserId(target, accessToken);
    const ok = await removeUser(tokens.user_id, resolved.id, accessToken, cfg);
    trackCost(cfg.removeOp, `/2/users/${tokens.user_id}/${cfg.path}/${resolved.id}`, 0);

    if (json) {
      console.log(
        JSON.stringify({ success: ok, user_id: resolved.id, username: resolved.username, action: `${mode}_remove` }, null, 2),
      );
      return;
    }

    console.log(
      ok
        ? `✅ Removed ${mode === "blocks" ? "block" : "mute"} for @${resolved.username}`
        : `Failed to remove ${mode === "blocks" ? "block" : "mute"} for @${resolved.username}`,
    );
    return;
  }

  usage(mode);
}

export async function cmdBlocks(rawArgs: string[]): Promise<void> {
  await runMode("blocks", rawArgs);
}

export async function cmdMutes(rawArgs: string[]): Promise<void> {
  await runMode("mutes", rawArgs);
}

