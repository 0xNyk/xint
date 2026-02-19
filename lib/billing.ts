/**
 * billing.ts - Plan entitlement and usage views for package API monetization.
 */

import { readFileSync } from "fs";
import { join } from "path";

function envOrDotEnv(key: string): string | undefined {
  const direct = process.env[key];
  if (direct && direct.trim()) return direct.trim();
  try {
    const envPath = join(import.meta.dir, "..", ".env");
    const raw = readFileSync(envPath, "utf-8");
    const match = raw.match(new RegExp(`^${key}=["']?([^"'\\n]+)`, "m"));
    if (match?.[1]) return match[1].trim();
  } catch {
    // no-op; fall back to runtime env/defaults
  }
  return undefined;
}

function packageApiBaseUrl(): string {
  return envOrDotEnv("XINT_PACKAGE_API_BASE_URL") || "http://localhost:8080/v1";
}

function packageApiKey(): string | undefined {
  return envOrDotEnv("XINT_PACKAGE_API_KEY");
}

function workspaceId(): string | undefined {
  return envOrDotEnv("XINT_WORKSPACE_ID");
}

async function callPackageApi(path: string): Promise<any> {
  const url = `${packageApiBaseUrl().replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = {};
  const apiKey = packageApiKey();
  const ws = workspaceId();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (ws) headers["x-workspace-id"] = ws;

  const response = await fetch(url, { headers });
  const text = await response.text();
  let data: any = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Package API returned non-JSON response (${response.status})`);
    }
  }
  if (!response.ok) {
    const code = data?.code ? ` [${data.code}]` : "";
    const message = data?.error || `HTTP ${response.status}`;
    throw new Error(`Package API${code}: ${message}`);
  }
  return data;
}

function parseDays(args: string[]): number {
  const daysArg = args.find((arg) => arg.startsWith("--days="));
  const fromFlag = daysArg ? parseInt(daysArg.split("=")[1], 10) : 30;
  if (!Number.isFinite(fromFlag) || fromFlag < 1) return 30;
  return Math.min(fromFlag, 365);
}

export async function cmdBilling(args: string[]): Promise<void> {
  const subcommand = args[0] || "status";
  const asJson = args.includes("--json");

  if (subcommand === "status") {
    const data = await callPackageApi("/billing/entitlements");
    if (asJson) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const plan = data?.entitlements?.plan || "unknown";
    const limits = data?.entitlements?.limits || {};
    const features = data?.entitlements?.features || {};
    const usage = data?.usage || {};
    const workspace = data?.workspace?.id || "unknown";

    console.log(`Billing status for workspace: ${workspace}`);
    console.log(`Plan: ${plan}`);
    console.log(`Limits: max_packages=${limits.max_packages ?? "n/a"}, max_query_claims=${limits.max_query_claims ?? "n/a"}`);
    console.log(`Features: shared_publish=${features.shared_publish ? "yes" : "no"}, audit_log_access=${features.audit_log_access ? "yes" : "no"}`);
    console.log(`Usage: package_count=${usage.current_package_count ?? 0}, created=${usage.package_create_count ?? 0}, queried=${usage.package_query_count ?? 0}`);
    return;
  }

  if (subcommand === "usage") {
    const days = parseDays(args);
    const data = await callPackageApi(`/billing/usage?days=${days}`);
    if (asJson) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const workspace = data?.workspace?.id || "unknown";
    const byOperation = data?.units_by_operation || {};
    console.log(`Billing usage for workspace: ${workspace} (${days}d)`);
    for (const [op, units] of Object.entries(byOperation)) {
      console.log(`- ${op}: ${units}`);
    }
    console.log(`Event count: ${data?.event_count ?? 0}`);
    return;
  }

  console.log(`billing commands:
  billing status [--json]            Show plan, limits, and feature entitlements
  billing usage [--days=N] [--json]  Show metered units by operation`);
}

