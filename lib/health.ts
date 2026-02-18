/**
 * lib/health.ts — runtime health and auth diagnostics.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { BASE } from "./api";
import { checkBudget, getTodayCosts } from "./costs";
import { getReliabilityReport } from "./reliability";
import { loadTokens } from "./oauth";

type StatusLevel = "ok" | "warn" | "fail";

interface ServiceCheck {
  configured: boolean;
  valid: boolean;
  status: StatusLevel;
  message: string;
  latency_ms: number | null;
  status_code: number | null;
}

interface OAuthCheck {
  configured: boolean;
  valid: boolean;
  status: StatusLevel;
  username: string | null;
  expires_in_minutes: number | null;
  missing_scopes: string[];
  message: string;
  status_code: number | null;
}

interface AuthDoctorReport {
  checked_at: string;
  bearer: ServiceCheck;
  xai: ServiceCheck;
  oauth: OAuthCheck;
  overall_status: StatusLevel;
}

interface HealthReport {
  checked_at: string;
  overall_status: StatusLevel;
  auth: AuthDoctorReport;
  budget: {
    allowed: boolean;
    warning: boolean;
    spent_usd: number;
    limit_usd: number;
    remaining_usd: number;
  };
  today: {
    calls: number;
    tweets_read: number;
    total_cost_usd: number;
  };
  reliability: ReturnType<typeof getReliabilityReport>;
}

const ENV_FILE = join(import.meta.dir, "..", ".env");
const REQUIRED_OAUTH_SCOPES = [
  "bookmark.read",
  "bookmark.write",
  "like.read",
  "like.write",
  "follows.read",
  "follows.write",
  "list.read",
  "list.write",
  "block.read",
  "block.write",
  "mute.read",
  "mute.write",
  "tweet.read",
  "tweet.write",
  "users.read",
  "offline.access",
];

function combineStatus(current: StatusLevel, next: StatusLevel): StatusLevel {
  const rank: Record<StatusLevel, number> = { ok: 1, warn: 2, fail: 3 };
  return rank[next] > rank[current] ? next : current;
}

function parseEnvFile(): Record<string, string> {
  try {
    const raw = readFileSync(ENV_FILE, "utf-8");
    const out: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const valueRaw = trimmed.slice(eq + 1).trim();
      const value = valueRaw.replace(/^['"]|['"]$/g, "");
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function getConfigValue(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const env = parseEnvFile();
  return env[name] || undefined;
}

async function checkBearerToken(token: string | undefined): Promise<ServiceCheck> {
  if (!token) {
    return {
      configured: false,
      valid: false,
      status: "fail",
      message: "X_BEARER_TOKEN missing",
      latency_ms: null,
      status_code: null,
    };
  }

  const started = Date.now();
  const url = `${BASE}/users/by/username/x?user.fields=id`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    return {
      configured: true,
      valid: res.ok,
      status: res.ok ? "ok" : "fail",
      message: res.ok ? "Bearer token valid" : `Bearer token check failed (${res.status})`,
      latency_ms: Date.now() - started,
      status_code: res.status,
    };
  } catch (error) {
    return {
      configured: true,
      valid: false,
      status: "warn",
      message: `Bearer token check error: ${error instanceof Error ? error.message : String(error)}`,
      latency_ms: Date.now() - started,
      status_code: null,
    };
  }
}

async function checkXaiToken(token: string | undefined): Promise<ServiceCheck> {
  if (!token) {
    return {
      configured: false,
      valid: false,
      status: "warn",
      message: "XAI_API_KEY missing (AI features disabled)",
      latency_ms: null,
      status_code: null,
    };
  }

  const started = Date.now();
  const url = "https://api.x.ai/v1/models";

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    return {
      configured: true,
      valid: res.ok,
      status: res.ok ? "ok" : "fail",
      message: res.ok ? "xAI key valid" : `xAI key check failed (${res.status})`,
      latency_ms: Date.now() - started,
      status_code: res.status,
    };
  } catch (error) {
    return {
      configured: true,
      valid: false,
      status: "warn",
      message: `xAI key check error: ${error instanceof Error ? error.message : String(error)}`,
      latency_ms: Date.now() - started,
      status_code: null,
    };
  }
}

async function checkOAuthTokens(): Promise<OAuthCheck> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      configured: false,
      valid: false,
      status: "warn",
      username: null,
      expires_in_minutes: null,
      missing_scopes: REQUIRED_OAUTH_SCOPES,
      message: "OAuth tokens missing (engagement/moderation commands unavailable)",
      status_code: null,
    };
  }

  const expiresInMinutes = Math.floor((tokens.expires_at - Date.now()) / 60_000);
  const tokenScopes = new Set(tokens.scope.split(/\s+/).filter(Boolean));
  const missingScopes = REQUIRED_OAUTH_SCOPES.filter((scope) => !tokenScopes.has(scope));

  try {
    const res = await fetch(`${BASE}/users/me`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    const valid = res.ok;
    let status: StatusLevel = "ok";
    let message = valid ? "OAuth access token valid" : `OAuth token check failed (${res.status})`;

    if (expiresInMinutes <= 0) {
      status = "warn";
      message = "OAuth access token expired (refresh required)";
    }
    if (missingScopes.length > 0) {
      status = combineStatus(status, "warn");
      message = `${message}; missing scopes: ${missingScopes.join(", ")}`;
    }
    if (!valid) {
      status = "fail";
    }

    return {
      configured: true,
      valid,
      status,
      username: tokens.username,
      expires_in_minutes: expiresInMinutes,
      missing_scopes: missingScopes,
      message,
      status_code: res.status,
    };
  } catch (error) {
    return {
      configured: true,
      valid: false,
      status: "warn",
      username: tokens.username,
      expires_in_minutes: expiresInMinutes,
      missing_scopes: missingScopes,
      message: `OAuth token check error: ${error instanceof Error ? error.message : String(error)}`,
      status_code: null,
    };
  }
}

async function collectAuthDoctorReport(): Promise<AuthDoctorReport> {
  const bearer = await checkBearerToken(getConfigValue("X_BEARER_TOKEN"));
  const xai = await checkXaiToken(getConfigValue("XAI_API_KEY"));
  const oauth = await checkOAuthTokens();

  let overall: StatusLevel = "ok";
  overall = combineStatus(overall, bearer.status);
  overall = combineStatus(overall, xai.status);
  overall = combineStatus(overall, oauth.status);

  return {
    checked_at: new Date().toISOString(),
    bearer,
    xai,
    oauth,
    overall_status: overall,
  };
}

function parseWindowDays(args: string[]): number {
  const idx = args.indexOf("--days");
  if (idx < 0 || idx + 1 >= args.length) return 7;
  const raw = parseInt(args[idx + 1], 10);
  if (Number.isNaN(raw)) return 7;
  return Math.max(1, Math.min(30, raw));
}

export async function cmdAuthDoctor(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const report = await collectAuthDoctorReport();

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const icon = (status: StatusLevel) => status === "ok" ? "✅" : status === "warn" ? "⚠️" : "❌";
  console.log(`${icon(report.overall_status)} Auth Doctor (${report.checked_at})`);
  console.log(`- Bearer: ${icon(report.bearer.status)} ${report.bearer.message}`);
  console.log(`- xAI: ${icon(report.xai.status)} ${report.xai.message}`);
  const oauthUser = report.oauth.username ? `@${report.oauth.username}` : "not configured";
  console.log(`- OAuth: ${icon(report.oauth.status)} ${report.oauth.message} (${oauthUser})`);
}

export async function cmdHealth(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const windowDays = parseWindowDays(args);
  const auth = await collectAuthDoctorReport();
  const budget = checkBudget();
  const today = getTodayCosts();
  const reliability = getReliabilityReport(windowDays);

  let overall: StatusLevel = auth.overall_status;
  if (!budget.allowed) {
    overall = combineStatus(overall, "warn");
  }
  if (reliability.total_calls > 0 && reliability.success_rate < 0.9) {
    overall = combineStatus(overall, "warn");
  }

  const report: HealthReport = {
    checked_at: new Date().toISOString(),
    overall_status: overall,
    auth,
    budget: {
      allowed: budget.allowed,
      warning: budget.warning,
      spent_usd: budget.spent,
      limit_usd: budget.limit,
      remaining_usd: budget.remaining,
    },
    today: {
      calls: today.calls,
      tweets_read: today.tweets_read,
      total_cost_usd: today.total_cost,
    },
    reliability,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const icon = (status: StatusLevel) => status === "ok" ? "✅" : status === "warn" ? "⚠️" : "❌";
  console.log(`${icon(report.overall_status)} xint Health (${report.checked_at})`);
  console.log(`- Auth status: ${icon(report.auth.overall_status)} ${report.auth.overall_status}`);
  console.log(`- Budget: ${report.budget.allowed ? "within limit" : "exceeded"} ($${report.budget.spent_usd.toFixed(2)} / $${report.budget.limit_usd.toFixed(2)})`);
  console.log(`- Reliability (${windowDays}d): ${(report.reliability.success_rate * 100).toFixed(1)}% success across ${report.reliability.total_calls} calls`);

  const topCommands = Object.entries(report.reliability.by_command)
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, 5);

  if (topCommands.length > 0) {
    console.log("- Top commands:");
    for (const [command, stats] of topCommands) {
      console.log(
        `  ${command}: ${(stats.success_rate * 100).toFixed(1)}% ok, p95 ${stats.p95_latency_ms.toFixed(0)}ms, fallback ${(stats.fallback_rate * 100).toFixed(1)}%`,
      );
    }
  }
}
