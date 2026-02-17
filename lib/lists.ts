/**
 * lists.ts — OAuth-authenticated X Lists management commands.
 * Supports listing owned lists, create/update/delete, and member management.
 */

import { BASE, oauthDelete, oauthGet, oauthPost, oauthPut } from "./api";
import { getValidToken, loadTokens } from "./oauth";
import { trackCost } from "./costs";

const LIST_FIELDS =
  "list.fields=id,name,owner_id,private,description,created_at,follower_count,member_count";
const USER_FIELDS = "user.fields=id,username,name,description,public_metrics";

interface XList {
  id: string;
  name: string;
  owner_id?: string;
  private?: boolean;
  description?: string;
  created_at?: string;
  follower_count?: number;
  member_count?: number;
}

interface XUser {
  id: string;
  username: string;
  name?: string;
  description?: string;
  public_metrics?: {
    followers_count?: number;
    following_count?: number;
    tweet_count?: number;
  };
}

interface ParsedFlags {
  json: boolean;
  limit: number;
}

export function parseCommonFlags(args: string[]): ParsedFlags {
  let json = false;
  let limit = 50;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--json":
        json = true;
        break;
      case "--limit":
        {
          const parsed = parseInt(args[++i] || "50", 10);
          limit = Math.max(1, Number.isNaN(parsed) ? 50 : parsed);
        }
        break;
    }
  }

  return { json, limit };
}

export function isLikelyUserId(value: string): boolean {
  return /^\d+$/.test(value);
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

async function fetchOwnedLists(userId: string, accessToken: string, maxTotal: number): Promise<XList[]> {
  const all: XList[] = [];
  let nextToken: string | undefined;

  while (all.length < maxTotal) {
    const perPage = Math.min(100, maxTotal - all.length);
    let url = `${BASE}/users/${userId}/owned_lists?max_results=${perPage}&${LIST_FIELDS}`;
    if (nextToken) url += `&pagination_token=${nextToken}`;

    const raw = await oauthGet(url, accessToken);
    const chunk: XList[] = raw?.data || [];
    if (chunk.length === 0) break;

    all.push(...chunk);
    nextToken = raw?.meta?.next_token;
    if (!nextToken) break;
  }

  return all.slice(0, maxTotal);
}

async function createList(
  accessToken: string,
  input: { name: string; description?: string; private?: boolean },
): Promise<{ id: string; name?: string }> {
  const body: Record<string, unknown> = { name: input.name };
  if (input.description !== undefined) body.description = input.description;
  if (input.private !== undefined) body.private = input.private;

  const res = await oauthPost(`${BASE}/lists`, accessToken, body);
  return res?.data || {};
}

async function updateList(
  listId: string,
  accessToken: string,
  input: { name?: string; description?: string; private?: boolean },
): Promise<{ updated: boolean }> {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.description !== undefined) body.description = input.description;
  if (input.private !== undefined) body.private = input.private;

  const res = await oauthPut(`${BASE}/lists/${listId}`, accessToken, body);
  return { updated: res?.data?.updated === true };
}

async function deleteList(listId: string, accessToken: string): Promise<{ deleted: boolean }> {
  const res = await oauthDelete(`${BASE}/lists/${listId}`, accessToken);
  return { deleted: res?.data?.deleted === true };
}

async function fetchListMembers(listId: string, accessToken: string, maxTotal: number): Promise<XUser[]> {
  const all: XUser[] = [];
  let nextToken: string | undefined;

  while (all.length < maxTotal) {
    const perPage = Math.min(100, maxTotal - all.length);
    let url = `${BASE}/lists/${listId}/members?max_results=${perPage}&${USER_FIELDS}`;
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

async function addMember(listId: string, userId: string, accessToken: string): Promise<boolean> {
  const res = await oauthPost(`${BASE}/lists/${listId}/members`, accessToken, { user_id: userId });
  return res?.data?.is_member === true;
}

async function removeMember(listId: string, userId: string, accessToken: string): Promise<boolean> {
  const res = await oauthDelete(`${BASE}/lists/${listId}/members/${userId}`, accessToken);
  return res?.data?.is_member === false || res?.success === true;
}

function usage(): void {
  console.log(`Usage: xint lists <subcommand> [options]

Subcommands:
  list [--limit N] [--json]                              List your owned lists (default)
  create <name> [--description "..."] [--private] [--json]
  update <list_id> [--name "..."] [--description "..."] [--private|--public] [--json]
  delete <list_id> [--json]
  members list <list_id> [--limit N] [--json]
  members add <list_id> <@username|user_id> [--json]
  members remove <list_id> <@username|user_id> [--json]

Examples:
  xint lists
  xint lists create "AI Researchers" --description "Top AI accounts" --private
  xint lists update 1888 --name "AI + Robotics" --public
  xint lists delete 1888
  xint lists members list 1888 --limit 100
  xint lists members add 1888 @sama
  xint lists members remove 1888 2244994945`);
}

export async function cmdLists(rawArgs: string[]): Promise<void> {
  const sub = (rawArgs[0] || "list").toLowerCase();
  const args = rawArgs.slice(1);

  if (sub === "help" || sub === "-h" || sub === "--help") {
    usage();
    return;
  }

  const tokens = loadTokens();
  if (!tokens) throw new Error("Not authenticated. Run 'auth setup' first.");
  const accessToken = await getValidToken();

  if (sub === "list" || sub === "ls") {
    const { json, limit } = parseCommonFlags(args);
    const lists = await fetchOwnedLists(tokens.user_id, accessToken, limit);
    trackCost("lists_list", `/2/users/${tokens.user_id}/owned_lists`, lists.length);

    if (json) {
      console.log(JSON.stringify(lists, null, 2));
      return;
    }

    if (lists.length === 0) {
      console.log("No lists found.");
      return;
    }

    console.log(`\n📚 Lists — @${tokens.username} (${lists.length})\n`);
    for (let i = 0; i < lists.length; i++) {
      const item = lists[i];
      const visibility = item.private ? "private" : "public";
      const members = item.member_count ?? 0;
      const followers = item.follower_count ?? 0;
      console.log(`${i + 1}. ${item.name} (${visibility})`);
      console.log(`   id: ${item.id} · ${members} members · ${followers} followers`);
      if (item.description) console.log(`   ${item.description}`);
    }
    return;
  }

  if (sub === "create") {
    let name = "";
    let description: string | undefined;
    let isPrivate: boolean | undefined;
    let json = false;

    for (let i = 0; i < args.length; i++) {
      const token = args[i];
      switch (token) {
        case "--description":
          description = args[++i];
          break;
        case "--private":
          isPrivate = true;
          break;
        case "--public":
          isPrivate = false;
          break;
        case "--json":
          json = true;
          break;
        default:
          if (!token.startsWith("-")) {
            name = name ? `${name} ${token}` : token;
          }
      }
    }

    if (!name) {
      throw new Error("Usage: xint lists create <name> [--description \"...\"] [--private]");
    }

    const created = await createList(accessToken, { name, description, private: isPrivate });
    trackCost("lists_create", "/2/lists", 0);

    if (json) {
      console.log(JSON.stringify(created, null, 2));
      return;
    }

    console.log(`✅ Created list "${name}"`);
    if (created?.id) console.log(`   id: ${created.id}`);
    return;
  }

  if (sub === "update") {
    const listId = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
    if (!listId) {
      throw new Error(
        "Usage: xint lists update <list_id> [--name \"...\"] [--description \"...\"] [--private|--public]",
      );
    }

    let name: string | undefined;
    let description: string | undefined;
    let isPrivate: boolean | undefined;
    let json = false;

    for (let i = 1; i < args.length; i++) {
      const token = args[i];
      switch (token) {
        case "--name":
          name = args[++i];
          break;
        case "--description":
          description = args[++i];
          break;
        case "--private":
          isPrivate = true;
          break;
        case "--public":
          isPrivate = false;
          break;
        case "--json":
          json = true;
          break;
      }
    }

    if (name === undefined && description === undefined && isPrivate === undefined) {
      throw new Error("No changes provided. Use --name, --description, --private, or --public.");
    }

    const result = await updateList(listId, accessToken, { name, description, private: isPrivate });
    trackCost("lists_update", `/2/lists/${listId}`, 0);

    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(result.updated ? `✅ Updated list ${listId}` : `No changes applied to list ${listId}`);
    return;
  }

  if (sub === "delete" || sub === "remove" || sub === "rm") {
    const listId = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
    const json = args.includes("--json");
    if (!listId) throw new Error("Usage: xint lists delete <list_id>");

    const result = await deleteList(listId, accessToken);
    trackCost("lists_delete", `/2/lists/${listId}`, 0);

    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(result.deleted ? `✅ Deleted list ${listId}` : `Failed to delete list ${listId}`);
    return;
  }

  if (sub === "members" || sub === "member") {
    const memberAction = (args[0] || "list").toLowerCase();
    const memberArgs = args.slice(1);

    if (memberAction === "list" || memberAction === "ls") {
      const listId = memberArgs[0] && !memberArgs[0].startsWith("-") ? memberArgs[0] : undefined;
      if (!listId) throw new Error("Usage: xint lists members list <list_id> [--limit N] [--json]");

      const { json, limit } = parseCommonFlags(memberArgs);
      const members = await fetchListMembers(listId, accessToken, limit);
      trackCost("list_members_list", `/2/lists/${listId}/members`, members.length);

      if (json) {
        console.log(JSON.stringify(members, null, 2));
        return;
      }

      if (members.length === 0) {
        console.log(`No members found in list ${listId}.`);
        return;
      }

      console.log(`\n👥 List Members (${members.length}) — ${listId}\n`);
      for (let i = 0; i < members.length; i++) {
        const user = members[i];
        const followers = user.public_metrics?.followers_count;
        console.log(
          `${i + 1}. @${user.username}${user.name ? ` — ${user.name}` : ""}${followers !== undefined ? ` (${followers} followers)` : ""}`,
        );
      }
      return;
    }

    if (memberAction === "add") {
      const listId = memberArgs[0];
      const userInput = memberArgs[1];
      const json = memberArgs.includes("--json");
      if (!listId || !userInput) throw new Error("Usage: xint lists members add <list_id> <@username|user_id>");

      const resolved = await resolveUserId(userInput, accessToken);
      const ok = await addMember(listId, resolved.id, accessToken);
      trackCost("list_members_add", `/2/lists/${listId}/members`, 0);

      if (json) {
        console.log(JSON.stringify({ success: ok, list_id: listId, user_id: resolved.id, username: resolved.username }, null, 2));
        return;
      }

      console.log(ok ? `✅ Added @${resolved.username} to list ${listId}` : `Failed to add @${resolved.username} to list ${listId}`);
      return;
    }

    if (memberAction === "remove" || memberAction === "rm" || memberAction === "delete") {
      const listId = memberArgs[0];
      const userInput = memberArgs[1];
      const json = memberArgs.includes("--json");
      if (!listId || !userInput) {
        throw new Error("Usage: xint lists members remove <list_id> <@username|user_id>");
      }

      const resolved = await resolveUserId(userInput, accessToken);
      const ok = await removeMember(listId, resolved.id, accessToken);
      trackCost("list_members_remove", `/2/lists/${listId}/members/${resolved.id}`, 0);

      if (json) {
        console.log(JSON.stringify({ success: ok, list_id: listId, user_id: resolved.id, username: resolved.username }, null, 2));
        return;
      }

      console.log(
        ok ? `✅ Removed @${resolved.username} from list ${listId}` : `Failed to remove @${resolved.username} from list ${listId}`,
      );
      return;
    }

    usage();
    return;
  }

  usage();
}
