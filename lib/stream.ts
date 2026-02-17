/**
 * stream.ts — Official X filtered stream + stream rules management.
 *
 * Uses:
 *   GET  /2/tweets/search/stream
 *   GET  /2/tweets/search/stream/rules
 *   POST /2/tweets/search/stream/rules
 */

import * as api from "./api";
import * as fmt from "./format";
import { checkBudget, trackCost } from "./costs";
import { buildOutputMeta } from "./output-meta";

interface StreamOptions {
  json?: boolean;
  jsonl?: boolean;
  maxEvents?: number;
  backfillMinutes?: number;
  webhook?: string;
  quiet?: boolean;
}

interface StreamRule {
  id: string;
  value: string;
  tag?: string;
}

const RULES_URL = `${api.BASE}/tweets/search/stream/rules`;

export function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function parseBackfillMinutes(value: string | undefined): number | null {
  const n = parsePositiveInt(value);
  if (n === null) return null;
  if (n < 1 || n > 5) return null;
  return n;
}

function nowIso(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

async function postWebhook(url: string, payload: any): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err: any) {
    console.error(`[webhook] Failed: ${err?.message || String(err)}`);
  }
}

async function listRules(): Promise<StreamRule[]> {
  const raw = await api.bearerGet(RULES_URL);
  const rules = Array.isArray(raw?.data) ? raw.data : [];
  return rules as StreamRule[];
}

async function addRule(value: string, tag?: string): Promise<any> {
  const body: any = { add: [{ value }] };
  if (tag) body.add[0].tag = tag;
  return api.bearerPost(RULES_URL, body);
}

async function deleteRules(ids: string[]): Promise<any> {
  return api.bearerPost(RULES_URL, { delete: { ids } });
}

function printStreamHelp(): void {
  console.log(`
Usage: xint stream [options]

Open official X filtered stream and print matching tweets in real time.
Manage stream rules with: xint stream-rules ...

Options:
  --json                 Output structured JSON per event
  --jsonl                Output compact JSONL per event
  --max-events N         Stop after N tweet events
  --backfill N           Backfill 1-5 minutes (X API option)
  --webhook <url>        POST each event payload to webhook
  --quiet, -q            Suppress stream status logs

Examples:
  xint stream
  xint stream --jsonl
  xint stream --backfill 2 --max-events 25
  xint stream --webhook https://hooks.example.com/ingest
`);
}

function printStreamRulesHelp(): void {
  console.log(`
Usage: xint stream-rules <subcommand> [options]

Subcommands:
  list [--json]                          List current filtered-stream rules (default)
  add <rule expression> [--tag <tag>]    Add a rule
  delete <rule_id...>                    Delete one or more rule IDs
  clear                                  Delete all rules

Examples:
  xint stream-rules
  xint stream-rules add "from:elonmusk -is:retweet" --tag elon
  xint stream-rules delete 1770000012345678901
  xint stream-rules clear
`);
}

async function runStream(opts: StreamOptions): Promise<void> {
  const token = api.getBearerToken();
  const backfill = opts.backfillMinutes ? `&backfill_minutes=${opts.backfillMinutes}` : "";
  const url = `${api.BASE}/tweets/search/stream?${api.FIELDS}${backfill}`;

  const controller = new AbortController();
  let running = true;
  let eventsSeen = 0;
  const startMs = Date.now();

  const onSignal = () => {
    running = false;
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    if (!opts.quiet) {
      console.error("Connecting to X filtered stream...");
      console.error("Press Ctrl+C to stop");
    }

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });

    if (res.status === 429) {
      const reset = res.headers.get("x-rate-limit-reset");
      const waitSec = reset
        ? Math.max(Number.parseInt(reset, 10) - Math.floor(Date.now() / 1000), 1)
        : 60;
      throw new Error(`Rate limited. Resets in ${waitSec}s`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`X API ${res.status}: ${text.slice(0, 200)}`);
    }

    if (!res.body) throw new Error("No response body from stream endpoint.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (running) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        const line = rawLine.trim();
        if (!line) continue; // keep-alive newline

        let payload: any;
        try {
          payload = JSON.parse(line);
        } catch {
          continue;
        }
        if (!payload?.data) continue;

        const tweets = api.parseTweets(payload as any);
        if (tweets.length === 0) continue;

        trackCost("stream_connect", "/2/tweets/search/stream", tweets.length);

        for (const tweet of tweets) {
          eventsSeen += 1;
          const event = {
            timestamp: new Date().toISOString(),
            matching_rules: payload.matching_rules || [],
            tweet,
          };

          const meta = buildOutputMeta({
            source: "x_api_v2",
            startedAtMs: startMs,
            cached: false,
            confidence: 1,
            apiEndpoint: "/2/tweets/search/stream",
            estimatedCostUsd: 0.005,
          });

          if (opts.json) {
            console.log(JSON.stringify({ meta, data: event }, null, 2));
          } else if (opts.jsonl) {
            console.log(JSON.stringify({ ...meta, event }));
          } else {
            if (!opts.quiet) {
              console.error(`[${nowIso()}] Stream match (${event.matching_rules.length} rule(s))`);
            }
            console.log(fmt.formatTweetTelegram(tweet, undefined, { full: false }));
            console.log();
          }

          if (opts.webhook) {
            await postWebhook(opts.webhook, { source: "xint-stream", ...event });
          }

          const budget = checkBudget();
          if (!budget.allowed) {
            console.error(
              `\n!! Budget exceeded ($${budget.spent.toFixed(2)}/$${budget.limit.toFixed(2)}). Stopping stream.`,
            );
            running = false;
            break;
          }

          if (opts.maxEvents && eventsSeen >= opts.maxEvents) {
            running = false;
            break;
          }
        }
      }
    }
  } catch (err: any) {
    // Ignore abort errors from Ctrl+C.
    if (!(err?.name === "AbortError")) {
      throw err;
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    const elapsed = Math.round((Date.now() - startMs) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    if (!opts.quiet) {
      console.error(`\n--- Stream stopped ---`);
      console.error(`Duration: ${mins}m ${secs}s | Events: ${eventsSeen}`);
    }
  }
}

export async function cmdStream(args: string[]): Promise<void> {
  let json = false;
  let jsonl = false;
  let quiet = false;
  let maxEvents: number | undefined;
  let backfillMinutes: number | undefined;
  let webhook: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--json":
        json = true;
        break;
      case "--jsonl":
        jsonl = true;
        break;
      case "--quiet":
      case "-q":
        quiet = true;
        break;
      case "--max-events": {
        const parsed = parsePositiveInt(args[++i]);
        if (parsed === null) {
          throw new Error("Usage: --max-events requires a positive integer.");
        }
        maxEvents = parsed;
        break;
      }
      case "--backfill": {
        const parsed = parseBackfillMinutes(args[++i]);
        if (parsed === null) {
          throw new Error("Usage: --backfill requires an integer from 1 to 5.");
        }
        backfillMinutes = parsed;
        break;
      }
      case "--webhook":
        webhook = args[++i];
        if (!webhook) throw new Error("Usage: --webhook requires a URL.");
        break;
      case "--help":
      case "-h":
        printStreamHelp();
        return;
      default:
        throw new Error(`Unknown option for stream: ${arg}`);
    }
  }

  if (json && jsonl) {
    throw new Error("Use only one of --json or --jsonl.");
  }

  await runStream({ json, jsonl, quiet, maxEvents, backfillMinutes, webhook });
}

export async function cmdStreamRules(args: string[]): Promise<void> {
  let json = false;
  let tag: string | undefined;
  const parts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--json":
        json = true;
        break;
      case "--tag":
        tag = args[++i];
        if (!tag) throw new Error("Usage: --tag requires a value.");
        break;
      case "--help":
      case "-h":
        printStreamRulesHelp();
        return;
      default:
        parts.push(arg);
        break;
    }
  }

  const sub = (parts[0] || "list").toLowerCase();

  if (sub === "list") {
    const rules = await listRules();
    trackCost("stream_rules_list", "/2/tweets/search/stream/rules", 0);

    if (json) {
      console.log(JSON.stringify(rules, null, 2));
      return;
    }

    if (rules.length === 0) {
      console.log("No stream rules configured.");
      return;
    }

    console.log(`\n📡 Stream Rules (${rules.length})\n`);
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      const tagText = rule.tag ? ` [${rule.tag}]` : "";
      console.log(`${i + 1}. ${rule.id}${tagText}`);
      console.log(`   ${rule.value}`);
    }
    return;
  }

  if (sub === "add") {
    const value = parts.slice(1).join(" ").trim();
    if (!value) {
      throw new Error("Usage: xint stream-rules add <rule expression> [--tag <tag>]");
    }
    const res = await addRule(value, tag);
    trackCost("stream_rules_add", "/2/tweets/search/stream/rules", 0);

    if (json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    const added = Array.isArray(res?.data) ? res.data.length : 0;
    console.log(`✅ Added ${added || 1} stream rule(s).`);
    return;
  }

  if (sub === "delete") {
    const ids = parts.slice(1);
    if (ids.length === 0) {
      throw new Error("Usage: xint stream-rules delete <rule_id...>");
    }
    const res = await deleteRules(ids);
    trackCost("stream_rules_delete", "/2/tweets/search/stream/rules", 0);

    if (json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    console.log(`✅ Deleted ${ids.length} stream rule(s).`);
    return;
  }

  if (sub === "clear") {
    const rules = await listRules();
    if (rules.length === 0) {
      console.log("No stream rules to clear.");
      return;
    }
    const ids = rules.map((r) => r.id);
    const res = await deleteRules(ids);
    trackCost("stream_rules_delete", "/2/tweets/search/stream/rules", 0);

    if (json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    console.log(`✅ Cleared ${ids.length} stream rule(s).`);
    return;
  }

  throw new Error(`Unknown stream-rules subcommand: ${sub}`);
}
