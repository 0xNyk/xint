/**
 * lib/costs.ts — X API cost tracking and budget management
 *
 * Tracks per-call costs, maintains daily aggregates, and provides
 * budget limit checking for X API v2 pay-per-use pricing.
 */

import { join } from "path";
import { mkdirSync, renameSync, writeFileSync, readFileSync, existsSync, chmodSync } from "fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostEntry {
  timestamp: string;
  operation: string;
  endpoint: string;
  tweets_read: number;
  cost_usd: number;
}

export interface DailyAggregate {
  date: string;
  total_cost: number;
  calls: number;
  tweets_read: number;
  by_operation: Record<string, { calls: number; cost: number; tweets: number }>;
}

export interface BudgetConfig {
  daily_limit_usd: number;
  warn_threshold: number;
  enabled: boolean;
}

export interface CostData {
  entries: CostEntry[];
  daily: DailyAggregate[];
  budget: BudgetConfig;
  total_lifetime_usd: number;
}

export interface BudgetStatus {
  allowed: boolean;
  spent: number;
  limit: number;
  remaining: number;
  warning: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILL_DIR = import.meta.dir;
const DATA_FILE = join(SKILL_DIR, "..", "data", "api-costs.json");
const RETENTION_DAYS = 30;

export const COST_RATES: Record<string, { per_tweet: number; per_call: number }> = {
  search:          { per_tweet: 0.005, per_call: 0 },
  search_archive:  { per_tweet: 0.01,  per_call: 0 },
  bookmarks:       { per_tweet: 0.005, per_call: 0 },
  likes:           { per_tweet: 0.005, per_call: 0 },
  like:            { per_tweet: 0, per_call: 0.01 },
  unlike:          { per_tweet: 0, per_call: 0.01 },
  follow:          { per_tweet: 0, per_call: 0.01 },
  unfollow:        { per_tweet: 0, per_call: 0.01 },
  following:       { per_tweet: 0, per_call: 0.005 },
  media_metadata:  { per_tweet: 0.005, per_call: 0 },
  stream_connect:  { per_tweet: 0.005, per_call: 0 },
  stream_rules_list:   { per_tweet: 0, per_call: 0.01 },
  stream_rules_add:    { per_tweet: 0, per_call: 0.01 },
  stream_rules_delete: { per_tweet: 0, per_call: 0.01 },
  bookmark_save:   { per_tweet: 0, per_call: 0.01 },
  bookmark_remove: { per_tweet: 0, per_call: 0.01 },
  profile:         { per_tweet: 0.005, per_call: 0 },
  tweet:           { per_tweet: 0.005, per_call: 0 },
  trends:          { per_tweet: 0, per_call: 0.10 },
  thread:          { per_tweet: 0.005, per_call: 0 },
  followers:       { per_tweet: 0, per_call: 0.01 },  // per user returned
  following_list:  { per_tweet: 0, per_call: 0.01 },
  lists_list:      { per_tweet: 0, per_call: 0.01 },
  lists_create:    { per_tweet: 0, per_call: 0.01 },
  lists_update:    { per_tweet: 0, per_call: 0.01 },
  lists_delete:    { per_tweet: 0, per_call: 0.01 },
  list_members_list:   { per_tweet: 0, per_call: 0.01 },
  list_members_add:    { per_tweet: 0, per_call: 0.01 },
  list_members_remove: { per_tweet: 0, per_call: 0.01 },
  blocks_list:         { per_tweet: 0, per_call: 0.01 },
  blocks_add:          { per_tweet: 0, per_call: 0.01 },
  blocks_remove:       { per_tweet: 0, per_call: 0.01 },
  mutes_list:          { per_tweet: 0, per_call: 0.01 },
  mutes_add:           { per_tweet: 0, per_call: 0.01 },
  mutes_remove:        { per_tweet: 0, per_call: 0.01 },
};

const DEFAULT_BUDGET: BudgetConfig = {
  daily_limit_usd: 1.0,
  warn_threshold: 0.8,
  enabled: true,
};

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function defaultData(): CostData {
  return {
    entries: [],
    daily: [],
    budget: { ...DEFAULT_BUDGET },
    total_lifetime_usd: 0,
  };
}

function loadData(): CostData {
  if (!existsSync(DATA_FILE)) return defaultData();
  try {
    const raw = readFileSync(DATA_FILE, "utf-8");
    const data = JSON.parse(raw) as CostData;
    // Ensure budget fields exist (forward-compat)
    data.budget = { ...DEFAULT_BUDGET, ...data.budget };
    data.entries ??= [];
    data.daily ??= [];
    data.total_lifetime_usd ??= 0;
    return data;
  } catch {
    console.error("[costs] Failed to parse cost data, starting fresh");
    return defaultData();
  }
}

function saveData(data: CostData): void {
  const dir = join(SKILL_DIR, "..", "data");
  mkdirSync(dir, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  chmodSync(tmp, 0o660);
  renameSync(tmp, DATA_FILE);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function cutoffDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - RETENTION_DAYS);
  return d.toISOString();
}

/** Prune entries older than RETENTION_DAYS. */
function pruneEntries(data: CostData): void {
  const cutoff = cutoffDate();
  data.entries = data.entries.filter((e) => e.timestamp >= cutoff);

  const cutoffDay = cutoff.slice(0, 10);
  data.daily = data.daily.filter((d) => d.date >= cutoffDay);
}

/** Find or create today's DailyAggregate. */
function ensureDailyAggregate(data: CostData, date: string): DailyAggregate {
  let agg = data.daily.find((d) => d.date === date);
  if (!agg) {
    agg = { date, total_cost: 0, calls: 0, tweets_read: 0, by_operation: {} };
    data.daily.push(agg);
    data.daily.sort((a, b) => a.date.localeCompare(b.date));
  }
  return agg;
}

function updateAggregate(agg: DailyAggregate, entry: CostEntry): void {
  agg.total_cost += entry.cost_usd;
  agg.calls += 1;
  agg.tweets_read += entry.tweets_read;

  const op = agg.by_operation[entry.operation] ?? { calls: 0, cost: 0, tweets: 0 };
  op.calls += 1;
  op.cost += entry.cost_usd;
  op.tweets += entry.tweets_read;
  agg.by_operation[entry.operation] = op;
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Log a cost entry for an API call.
 * Auto-calculates cost from the operation type and tweet count.
 */
export function trackCost(
  operation: string,
  endpoint: string,
  tweetsRead: number,
): CostEntry {
  const rates = COST_RATES[operation];
  const costUsd = rates
    ? rates.per_call + rates.per_tweet * tweetsRead
    : 0.005 * tweetsRead; // fallback: assume tweet-read rate

  const entry: CostEntry = {
    timestamp: new Date().toISOString(),
    operation,
    endpoint,
    tweets_read: tweetsRead,
    cost_usd: Math.round(costUsd * 1e6) / 1e6, // avoid floating-point noise
  };

  const data = loadData();
  data.entries.push(entry);
  data.total_lifetime_usd = Math.round((data.total_lifetime_usd + entry.cost_usd) * 1e6) / 1e6;

  const day = entry.timestamp.slice(0, 10);
  const agg = ensureDailyAggregate(data, day);
  updateAggregate(agg, entry);

  pruneEntries(data);
  saveData(data);

  return entry;
}

/**
 * Check whether today's spend is within budget.
 * Returns status object — never throws.
 */
export function checkBudget(): BudgetStatus {
  const data = loadData();
  const today = getTodayCosts();
  const spent = today.total_cost;
  const limit = data.budget.daily_limit_usd;
  const remaining = Math.max(0, limit - spent);
  const warning = data.budget.enabled && spent >= limit * data.budget.warn_threshold;
  const allowed = !data.budget.enabled || spent < limit;

  return {
    allowed,
    spent: Math.round(spent * 1e4) / 1e4,
    limit,
    remaining: Math.round(remaining * 1e4) / 1e4,
    warning,
  };
}

/** Returns today's DailyAggregate (or an empty one). */
export function getTodayCosts(): DailyAggregate {
  const data = loadData();
  const today = todayStr();
  return (
    data.daily.find((d) => d.date === today) ?? {
      date: today,
      total_cost: 0,
      calls: 0,
      tweets_read: 0,
      by_operation: {},
    }
  );
}

/** Update the daily budget limit. */
export function setBudget(limitUsd: number): void {
  const data = loadData();
  data.budget.daily_limit_usd = limitUsd;
  saveData(data);
  console.error(`[costs] Daily budget set to $${limitUsd.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// Summary / reporting
// ---------------------------------------------------------------------------

function fmtUsd(n: number): string {
  return "$" + n.toFixed(2);
}

function padEnd(s: string, len: number): string {
  return s + " ".repeat(Math.max(0, len - s.length));
}

function padStart(s: string, len: number): string {
  return " ".repeat(Math.max(0, len - s.length)) + s;
}

function operationTable(byOp: Record<string, { calls: number; cost: number; tweets: number }>): string {
  const lines: string[] = [];
  const sorted = Object.entries(byOp).sort((a, b) => b[1].cost - a[1].cost);
  for (const [op, stats] of sorted) {
    const opCol = padEnd(op + ":", 16);
    const callsCol = padStart(String(stats.calls), 3) + " calls";
    const tweetsCol = padStart(String(stats.tweets), 5) + " tweets";
    const costCol = padStart(fmtUsd(stats.cost), 7);
    lines.push(`    ${opCol} ${callsCol}, ${tweetsCol}, ${costCol}`);
  }
  return lines.join("\n");
}

export function getCostSummary(period: "today" | "week" | "month" | "all"): string {
  const data = loadData();
  const today = todayStr();

  if (period === "today") {
    const agg = getTodayCosts();
    const budget = data.budget;
    const pct = budget.daily_limit_usd > 0
      ? Math.round((agg.total_cost / budget.daily_limit_usd) * 100)
      : 0;
    const remaining = 100 - pct;

    let out = `\u{1F4CA} API Costs \u2014 Today (${today})\n\n`;
    out += `  Total: ${fmtUsd(agg.total_cost)} / ${fmtUsd(budget.daily_limit_usd)} daily limit\n`;
    out += `  Calls: ${agg.calls} | Tweets read: ${agg.tweets_read}\n`;

    if (Object.keys(agg.by_operation).length > 0) {
      out += `\n  By operation:\n`;
      out += operationTable(agg.by_operation) + "\n";
    }

    out += `\n  Budget: ${pct}% used (${remaining}% remaining)`;
    return out;
  }

  // Determine date range
  let startDate: string;
  let label: string;
  if (period === "week") {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    startDate = d.toISOString().slice(0, 10);
    label = "Last 7 Days";
  } else if (period === "month") {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    startDate = d.toISOString().slice(0, 10);
    label = "Last 30 Days";
  } else {
    startDate = "";
    label = "All Time";
  }

  const days = data.daily
    .filter((d) => d.date >= startDate)
    .sort((a, b) => b.date.localeCompare(a.date));

  const totalCost = days.reduce((sum, d) => sum + d.total_cost, 0);
  const totalCalls = days.reduce((sum, d) => sum + d.calls, 0);
  const totalTweets = days.reduce((sum, d) => sum + d.tweets_read, 0);

  let out = `\u{1F4CA} API Costs \u2014 ${label}\n\n`;
  out += `  Total: ${fmtUsd(totalCost)} | Calls: ${totalCalls} | Tweets read: ${totalTweets}\n`;

  if (period === "all") {
    out += `  Lifetime total: ${fmtUsd(data.total_lifetime_usd)}\n`;
  }

  if (days.length > 0) {
    out += `\n  Daily breakdown:\n`;
    out += `    ${"Date".padEnd(12)} ${"Cost".padStart(8)} ${"Calls".padStart(6)} ${"Tweets".padStart(7)}\n`;
    out += `    ${"----".padEnd(12)} ${"----".padStart(8)} ${"-----".padStart(6)} ${"------".padStart(7)}\n`;
    for (const d of days) {
      out += `    ${d.date.padEnd(12)} ${fmtUsd(d.total_cost).padStart(8)} ${String(d.calls).padStart(6)} ${String(d.tweets_read).padStart(7)}\n`;
    }
  } else {
    out += "\n  No data for this period.\n";
  }

  return out;
}

// ---------------------------------------------------------------------------
// CLI handler
// ---------------------------------------------------------------------------

export function cmdCosts(args: string[]): void {
  const sub = args[0] ?? "today";

  if (sub === "budget") {
    const action = args[1];
    if (action === "set") {
      const val = parseFloat(args[2]);
      if (isNaN(val) || val < 0) {
        console.error("Usage: costs budget set <amount_usd>");
        process.exit(1);
      }
      setBudget(val);
      console.log(`Daily budget set to ${fmtUsd(val)}`);
      return;
    }
    // Show current budget
    const data = loadData();
    const status = checkBudget();
    console.log(`Budget: ${fmtUsd(data.budget.daily_limit_usd)}/day`);
    console.log(`Warn threshold: ${(data.budget.warn_threshold * 100).toFixed(0)}%`);
    console.log(`Enabled: ${data.budget.enabled}`);
    console.log(`Today: ${fmtUsd(status.spent)} spent, ${fmtUsd(status.remaining)} remaining`);
    return;
  }

  if (sub === "reset") {
    const data = loadData();
    const today = todayStr();
    data.entries = data.entries.filter((e) => e.timestamp.slice(0, 10) !== today);
    data.daily = data.daily.filter((d) => d.date !== today);
    saveData(data);
    console.log(`Reset today's (${today}) cost data.`);
    return;
  }

  if (sub === "today" || sub === "week" || sub === "month" || sub === "all") {
    console.log(getCostSummary(sub));
    return;
  }

  console.error(`Unknown costs subcommand: ${sub}`);
  console.error("Usage: costs [today|week|month|all|budget [set N]|reset]");
  process.exit(1);
}
