/**
 * lib/credits.ts — Grok free-tier credit telemetry.
 *
 * Computes a Grok-only view over the existing costs.ts data so users can see
 * how much of their console.x.ai free tier they've consumed this calendar
 * month. xAI's free tier ($25 signup + $150/mo data-share = $175/mo total) is
 * not exposed via API, so we model it locally:
 *
 *   • signup credit:  $25, expires 30 days after first xAI call we observed
 *   • monthly credit: $150, resets on the 1st of each UTC calendar month
 *
 * Users without data-sharing only get $25 — `xint credits --signup-only` flips
 * the model accordingly. Numbers are best-effort: actual remaining balance
 * lives at console.x.ai. The point is to give agents a steerable signal so
 * they know when to switch to --budget cheap.
 */

import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from "fs";
import { printCreditGuide } from "./grok";

// Grok-related operations as logged by lib/grok.ts and the xai_* helpers.
const GROK_OPS = new Set([
  "grok_chat",
  "grok_analyze",
  "grok_vision",
  "grok_sentiment",
  "xai_article",
  "xai_x_search",
  "grok_live_search",  // added by PR3
]);

const SKILL_DIR = import.meta.dir;
const COSTS_FILE = join(SKILL_DIR, "..", "data", "api-costs.json");
const CREDITS_FILE = join(SKILL_DIR, "..", "data", "credits.json");

const SIGNUP_CREDIT_USD = 25;
const MONTHLY_CREDIT_USD = 150;
const SIGNUP_VALIDITY_DAYS = 30;

interface CreditsMeta {
  // ISO date string of the first observed xAI call. Used to compute signup
  // credit expiry. If the user is on month 2+, this is historical; if absent,
  // we assume "today" so estimates skew optimistic.
  first_call_at?: string;
  // Whether the user opted into data-sharing ($150/mo bonus).
  data_sharing: boolean;
}

interface CostsShape {
  entries: Array<{
    timestamp: string;
    operation: string;
    cost_usd: number;
  }>;
}

function loadCosts(): CostsShape {
  if (!existsSync(COSTS_FILE)) return { entries: [] };
  try {
    return JSON.parse(readFileSync(COSTS_FILE, "utf-8")) as CostsShape;
  } catch {
    return { entries: [] };
  }
}

function loadMeta(): CreditsMeta {
  if (!existsSync(CREDITS_FILE)) return { data_sharing: true };
  try {
    return JSON.parse(readFileSync(CREDITS_FILE, "utf-8")) as CreditsMeta;
  } catch {
    return { data_sharing: true };
  }
}

function saveMeta(meta: CreditsMeta): void {
  const dir = join(SKILL_DIR, "..", "data");
  mkdirSync(dir, { recursive: true });
  const tmp = CREDITS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(meta, null, 2), "utf-8");
  chmodSync(tmp, 0o600);
  renameSync(tmp, CREDITS_FILE);
}

function monthStart(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

function nextMonthStart(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10);
}

interface CreditsSummary {
  signup_credit_total: number;
  signup_credit_used: number;       // approximated as min(total_grok_spend, signup_total)
  signup_expires_at: string | null; // null if no first call observed
  monthly_total: number;
  monthly_used: number;             // grok spend this calendar month
  monthly_resets_at: string;
  data_sharing: boolean;
  by_model: Record<string, number>;
  by_feature: Record<string, number>;
}

export function summarize(): CreditsSummary {
  const costs = loadCosts();
  const meta = loadMeta();
  const now = new Date();
  const monthFloor = monthStart(now);
  const monthCeiling = nextMonthStart(now);

  // First xAI call — record if absent, so the 30-day signup window has a start.
  const grokEntries = costs.entries.filter((e) => GROK_OPS.has(e.operation));
  let firstCall = meta.first_call_at;
  if (!firstCall && grokEntries.length > 0) {
    firstCall = grokEntries[0].timestamp;
    saveMeta({ ...meta, first_call_at: firstCall });
  }

  const signupExpiresAt = firstCall
    ? new Date(new Date(firstCall).getTime() + SIGNUP_VALIDITY_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10)
    : null;

  // Monthly spend = sum of Grok ops in current calendar month.
  const monthGrokEntries = grokEntries.filter(
    (e) => e.timestamp.slice(0, 10) >= monthFloor,
  );
  const monthlyUsed = monthGrokEntries.reduce((sum, e) => sum + e.cost_usd, 0);

  // By-feature (op type maps to feature)
  const byFeature: Record<string, number> = {};
  for (const e of monthGrokEntries) {
    const feature = featureBucket(e.operation);
    byFeature[feature] = (byFeature[feature] ?? 0) + e.cost_usd;
  }

  // By-model: not tracked in entries directly (lib/grok.ts only logs op + cost).
  // For now, leave empty — PR2 doesn't extend the entry schema; PR3 can add
  // a model field if we decide it's worth the migration cost.
  const byModel: Record<string, number> = {};

  const monthlyTotal = meta.data_sharing ? MONTHLY_CREDIT_USD : 0;

  return {
    signup_credit_total: SIGNUP_CREDIT_USD,
    signup_credit_used: Math.min(grokEntries.reduce((s, e) => s + e.cost_usd, 0), SIGNUP_CREDIT_USD),
    signup_expires_at: signupExpiresAt,
    monthly_total: monthlyTotal,
    monthly_used: round6(monthlyUsed),
    monthly_resets_at: monthCeiling,
    data_sharing: meta.data_sharing,
    by_model: byModel,
    by_feature: byFeature,
  };
}

function featureBucket(op: string): string {
  if (op === "grok_chat" || op === "grok_analyze") return "chat";
  if (op === "grok_vision") return "vision";
  if (op === "grok_sentiment") return "sentiment";
  if (op === "xai_article") return "article";
  if (op === "xai_x_search" || op === "grok_live_search") return "live_search";
  return op;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function fmtUsd(n: number): string {
  return "$" + n.toFixed(2);
}

function padEnd(s: string, len: number): string {
  return s + " ".repeat(Math.max(0, len - s.length));
}

export function cmdCredits(args: string[]): void {
  // Mutating subcommands first
  if (args[0] === "--setup" || args[0] === "setup") {
    printCreditGuide(process.env.XINT_X_PREMIUM);
    return;
  }
  if (args[0] === "--data-sharing") {
    const val = args[1];
    if (val !== "on" && val !== "off") {
      console.error("Usage: xint credits --data-sharing on|off");
      process.exit(1);
    }
    const meta = loadMeta();
    meta.data_sharing = val === "on";
    saveMeta(meta);
    console.log(`Data-sharing set to ${val}. Monthly free tier: ${val === "on" ? "$150" : "$0"}.`);
    return;
  }
  if (args[0] === "--explain" || args[0] === "explain") {
    printCreditGuide(process.env.XINT_X_PREMIUM);
    return;
  }

  const s = summarize();
  console.log(`\nFree tier (xAI console)`);
  const signupRemaining = Math.max(0, s.signup_credit_total - s.signup_credit_used);
  const signupExp = s.signup_expires_at ? `expires ${s.signup_expires_at}` : "starts on first call";
  console.log(`  Signup credit:    ${fmtUsd(signupRemaining)} of ${fmtUsd(s.signup_credit_total)} remaining   ${signupExp}`);

  if (s.data_sharing) {
    console.log(`  Monthly:          ${fmtUsd(s.monthly_used)} of ${fmtUsd(s.monthly_total)} used        refreshes ${s.monthly_resets_at}`);
  } else {
    console.log(`  Monthly:          data-sharing OFF — $0/mo bonus. Run \`xint credits --data-sharing on\` to enable.`);
  }

  const nonzero = Object.entries(s.by_feature).filter(([, v]) => v > 0);
  if (nonzero.length > 0) {
    console.log(`\nThis month by feature`);
    const sorted = nonzero.sort((a, b) => b[1] - a[1]);
    for (const [feature, cost] of sorted) {
      console.log(`  ${padEnd(feature, 16)}  ${fmtUsd(cost)}`);
    }
  } else {
    console.log(`\nNo Grok calls this month yet. Try \`xint analyze "your question"\`.`);
  }

  // Tip: cheap-budget hit rate
  const chatSpend = s.by_feature["chat"] ?? 0;
  if (s.monthly_used > 0 && chatSpend / s.monthly_used > 0.9) {
    console.log(`\nTip: ${Math.round((chatSpend / s.monthly_used) * 100)}% of spend went to general queries — \`--budget cheap\` is working.`);
  }

  console.log(``);
}
