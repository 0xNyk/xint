/**
 * Machine-readable capability manifest for agent runtimes.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { COST_RATES } from "./costs";

type CapabilityMode = "read_only" | "engagement" | "moderation";

function packageVersion(): string {
  try {
    const pkgPath = join(import.meta.dir, "..", "package.json");
    const parsed = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return parsed.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function pricingOperations() {
  return Object.fromEntries(
    Object.entries(COST_RATES)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([operation, rates]) => [
        operation,
        {
          per_call_usd: rates.per_call,
          per_tweet_usd: rates.per_tweet,
        },
      ])
  );
}

function capabilitiesList() {
  return [
    { id: "search", provider: "x_api_v2", auth: "X_BEARER_TOKEN", mode: "read_only" as CapabilityMode },
    { id: "profile", provider: "x_api_v2", auth: "X_BEARER_TOKEN", mode: "read_only" as CapabilityMode },
    { id: "tweet", provider: "x_api_v2", auth: "X_BEARER_TOKEN", mode: "read_only" as CapabilityMode },
    { id: "thread", provider: "x_api_v2", auth: "X_BEARER_TOKEN", mode: "read_only" as CapabilityMode },
    { id: "trends", provider: "x_api_v2", auth: "X_BEARER_TOKEN", mode: "read_only" as CapabilityMode },
    { id: "article", provider: "xai_grok", auth: "XAI_API_KEY", mode: "read_only" as CapabilityMode },
    { id: "analyze", provider: "xai_grok", auth: "XAI_API_KEY", mode: "read_only" as CapabilityMode },
    { id: "report", provider: "xai_grok", auth: "X_BEARER_TOKEN+XAI_API_KEY", mode: "read_only" as CapabilityMode },
    { id: "x_search", provider: "xai_grok", auth: "XAI_API_KEY", mode: "read_only" as CapabilityMode },
    { id: "bookmarks", provider: "x_api_v2", auth: "OAuth2 PKCE", mode: "engagement" as CapabilityMode },
    { id: "likes", provider: "x_api_v2", auth: "OAuth2 PKCE", mode: "engagement" as CapabilityMode },
    { id: "follow", provider: "x_api_v2", auth: "OAuth2 PKCE", mode: "engagement" as CapabilityMode },
    { id: "lists", provider: "x_api_v2", auth: "OAuth2 PKCE", mode: "engagement" as CapabilityMode },
    { id: "blocks", provider: "x_api_v2", auth: "OAuth2 PKCE", mode: "moderation" as CapabilityMode },
    { id: "mutes", provider: "x_api_v2", auth: "OAuth2 PKCE", mode: "moderation" as CapabilityMode },
    { id: "stream", provider: "x_api_v2", auth: "X_BEARER_TOKEN", mode: "read_only" as CapabilityMode },
    { id: "mcp", provider: "local_mcp", auth: "none", mode: "read_only" as CapabilityMode },
  ];
}

export function getCapabilitiesManifest() {
  return {
    schema_version: "1.0.0",
    service: {
      name: "xint",
      implementation: "typescript",
      version: packageVersion(),
      runtime: "cli",
      protocols: ["cli", "mcp"],
    },
    discovery: {
      command: "xint capabilities --json",
      content_type: "application/json",
      supports_compact: true,
    },
    constraints: {
      x_api_only: true,
      xai_grok_only: true,
      graphql: false,
      session_cookies: false,
    },
    capability_modes: [
      {
        mode: "read_only",
        description: "Read/search/report operations with no account mutation.",
      },
      {
        mode: "engagement",
        description: "Account actions (likes, follows, bookmarks, lists) via OAuth scopes.",
      },
      {
        mode: "moderation",
        description: "Safety actions (block/mute) via OAuth scopes.",
      },
    ],
    telemetry: {
      fields: ["source", "latency_ms", "cached", "confidence", "api_endpoint", "timestamp"],
      budget_fields: ["estimated_cost_usd", "budget_remaining_usd"],
    },
    pricing: {
      model: "estimated_per_call_usd",
      currency: "USD",
      source: "local_cost_table",
      operations: pricingOperations(),
    },
    policy: {
      allowlist_default: "read_only",
      enterprise_controls: ["mode_allowlist", "budget_guard", "oauth_scope_boundaries"],
    },
    capabilities: capabilitiesList(),
  };
}

export function cmdCapabilities(argv: string[]): void {
  const compact = argv.includes("--compact");
  const manifest = getCapabilitiesManifest();
  console.log(compact ? JSON.stringify(manifest) : JSON.stringify(manifest, null, 2));
}
