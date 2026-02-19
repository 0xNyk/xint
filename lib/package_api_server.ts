/**
 * Local package API server for Agent Memory V1.
 *
 * Development-only server to back MCP package tools locally.
 * Base URL: http://localhost:8080/v1
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

interface TimeWindow {
  from: string;
  to: string;
}

interface Freshness {
  updated_at: string;
  ttl_seconds: number;
  stale: boolean;
}

interface Snapshot {
  package_id: string;
  version: number;
  created_at: string;
  evidence_count: number;
  claim_count: number;
  quality_score: number;
}

interface PackageRecord {
  id: string;
  tenant_id: string;
  name: string;
  topic_query: string;
  sources: string[];
  policy: "private" | "shared_candidate" | "shared";
  analysis_profile: "summary" | "analyst" | "forensic";
  time_window: TimeWindow;
  latest_snapshot_version: number;
  freshness: Freshness;
  snapshots: Snapshot[];
}

interface AuditEvent {
  id: string;
  type: string;
  actor: string;
  created_at: string;
  details: Record<string, unknown>;
}

interface Store {
  packages: Record<string, PackageRecord>;
  audit_events: AuditEvent[];
  workspaces?: Record<string, WorkspaceRecord>;
  usage_events?: UsageEvent[];
}

type PlanName = "free" | "pro" | "team" | "enterprise";

interface PlanLimits {
  max_packages: number;
  max_query_claims: number;
}

interface PlanOverages {
  package_query_per_1k_usd?: number;
}

interface PlanFeatures {
  shared_publish: boolean;
  audit_log_access: boolean;
}

interface WorkspaceEntitlements {
  plan: PlanName;
  features: PlanFeatures;
  limits: PlanLimits;
  overages: PlanOverages;
  updated_at: string;
}

interface WorkspaceUsage {
  package_create_count: number;
  package_query_count: number;
  package_refresh_count: number;
  package_publish_count: number;
  updated_at: string;
}

interface WorkspaceRecord {
  id: string;
  name: string;
  entitlements: WorkspaceEntitlements;
  usage: WorkspaceUsage;
}

interface UsageEvent {
  id: string;
  workspace_id: string;
  actor: string;
  operation:
    | "package.create"
    | "package.query"
    | "package.refresh"
    | "package.publish"
    | "package.search"
    | "package.status";
  units: number;
  request_id: string;
  created_at: string;
}

const STORE_PATH = join(import.meta.dir, "..", "data", "package-api-store.json");
const API_PREFIX = "/v1";
const DEFAULT_TTL_SECONDS = 21_600;
const DEFAULT_WORKSPACE_ID = "ws_local";
const DEFAULT_WORKSPACE_NAME = "Local Workspace";
const DEFAULT_PLAN_NAME: PlanName = "free";

const PLAN_CATALOG: Record<PlanName, { features: PlanFeatures; limits: PlanLimits; overages: PlanOverages }> = {
  free: {
    features: { shared_publish: false, audit_log_access: true },
    limits: { max_packages: 3, max_query_claims: 10 },
    overages: {},
  },
  pro: {
    features: { shared_publish: true, audit_log_access: true },
    limits: { max_packages: 100, max_query_claims: 50 },
    overages: { package_query_per_1k_usd: 2 },
  },
  team: {
    features: { shared_publish: true, audit_log_access: true },
    limits: { max_packages: 1000, max_query_claims: 100 },
    overages: { package_query_per_1k_usd: 1.5 },
  },
  enterprise: {
    features: { shared_publish: true, audit_log_access: true },
    limits: { max_packages: 10_000, max_query_claims: 500 },
    overages: { package_query_per_1k_usd: 1 },
  },
};

function nowIso(): string {
  return new Date().toISOString();
}

function loadStore(): Store {
  if (!existsSync(STORE_PATH)) return { packages: {}, audit_events: [] };
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf-8")) as Store;
    return {
      packages: parsed.packages || {},
      audit_events: parsed.audit_events || [],
      workspaces: parsed.workspaces || {},
      usage_events: parsed.usage_events || [],
    };
  } catch {
    return { packages: {}, audit_events: [] };
  }
}

function saveStore(store: Store): void {
  const dir = join(import.meta.dir, "..", "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function addAuditEvent(
  store: Store,
  type: string,
  actor: string,
  details: Record<string, unknown>
): void {
  store.audit_events.unshift({
    id: `evt_${randomUUID()}`,
    type,
    actor,
    created_at: nowIso(),
    details,
  });
  if (store.audit_events.length > 5000) {
    store.audit_events = store.audit_events.slice(0, 5000);
  }
}

function addUsageEvent(
  store: Store,
  workspaceId: string,
  actor: string,
  operation: UsageEvent["operation"],
  units: number,
  requestId: string
): void {
  if (!store.usage_events) store.usage_events = [];
  store.usage_events.unshift({
    id: `use_${randomUUID().slice(0, 8)}`,
    workspace_id: workspaceId,
    actor,
    operation,
    units,
    request_id: requestId,
    created_at: nowIso(),
  });
  if (store.usage_events.length > 20_000) {
    store.usage_events = store.usage_events.slice(0, 20_000);
  }
}

function makeEntitlements(plan: PlanName): WorkspaceEntitlements {
  const preset = PLAN_CATALOG[plan];
  return {
    plan,
    features: { ...preset.features },
    limits: { ...preset.limits },
    overages: { ...preset.overages },
    updated_at: nowIso(),
  };
}

function ensureWorkspaceStore(store: Store): void {
  if (!store.workspaces) store.workspaces = {};
  if (!store.workspaces[DEFAULT_WORKSPACE_ID]) {
    const plan = parsePlanName(process.env.XINT_PACKAGE_API_PLAN);
    store.workspaces[DEFAULT_WORKSPACE_ID] = {
      id: DEFAULT_WORKSPACE_ID,
      name: DEFAULT_WORKSPACE_NAME,
      entitlements: makeEntitlements(plan),
      usage: {
        package_create_count: 0,
        package_query_count: 0,
        package_refresh_count: 0,
        package_publish_count: 0,
        updated_at: nowIso(),
      },
    };
  }
}

function parsePlanName(raw: string | undefined): PlanName {
  const normalized = String(raw || "").toLowerCase().trim();
  if (normalized === "pro" || normalized === "team" || normalized === "enterprise" || normalized === "free") {
    return normalized;
  }
  return DEFAULT_PLAN_NAME;
}

function resolveWorkspace(req: any, store: Store): WorkspaceRecord {
  ensureWorkspaceStore(store);
  const requested = String(req.headers["x-workspace-id"] || DEFAULT_WORKSPACE_ID).trim() || DEFAULT_WORKSPACE_ID;
  if (!store.workspaces![requested]) {
    store.workspaces![requested] = {
      id: requested,
      name: `Workspace ${requested}`,
      entitlements: makeEntitlements(parsePlanName(process.env.XINT_PACKAGE_API_PLAN)),
      usage: {
        package_create_count: 0,
        package_query_count: 0,
        package_refresh_count: 0,
        package_publish_count: 0,
        updated_at: nowIso(),
      },
    };
  }
  return store.workspaces![requested];
}

function sendMonetizationError(
  res: any,
  status: number,
  code: "PLAN_REQUIRED" | "QUOTA_EXCEEDED" | "FEATURE_NOT_IN_PLAN",
  message: string,
  details: Record<string, unknown> = {}
): void {
  sendJson(res, status, {
    error: message,
    code,
    details,
  });
}

function countPackagesForWorkspace(store: Store, workspaceId: string): number {
  return Object.values(store.packages).filter((pkg) => pkg.tenant_id === workspaceId).length;
}

function bumpWorkspaceUsage(workspace: WorkspaceRecord, key: keyof WorkspaceUsage): void {
  const current = workspace.usage[key];
  if (typeof current === "number") {
    workspace.usage[key] = current + 1;
  }
  workspace.usage.updated_at = nowIso();
}

function sendJson(res: any, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: any): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function requireAuthIfConfigured(req: any, res: any): boolean {
  const requiredKey = process.env.XINT_PACKAGE_API_KEY;
  if (!requiredKey) return true;
  const auth = req.headers.authorization;
  if (auth === `Bearer ${requiredKey}`) return true;
  sendJson(res, 401, { error: "Unauthorized" });
  return false;
}

function normalizeCreateBody(body: Record<string, unknown>) {
  const name = String(body.name || "");
  const topicQuery = String(body.topic_query || body.topicQuery || "");
  const sources = Array.isArray(body.sources) ? body.sources.map(String) : [];
  const timeWindowRaw = (body.time_window || body.timeWindow || {}) as Record<string, unknown>;
  const from = String(timeWindowRaw.from || "");
  const to = String(timeWindowRaw.to || "");
  const policy = String(body.policy || "private");
  const analysisProfile = String(body.analysis_profile || body.analysisProfile || "summary");

  return {
    name,
    topic_query: topicQuery,
    sources,
    time_window: { from, to },
    policy,
    analysis_profile: analysisProfile,
  };
}

function asActor(req: any): string {
  const fromHeader = req.headers["x-actor-id"];
  return typeof fromHeader === "string" && fromHeader.trim() ? fromHeader : "local-dev";
}

function asRequestId(req: any): string {
  const fromHeader = req.headers["x-request-id"];
  if (typeof fromHeader === "string" && fromHeader.trim()) return fromHeader.trim();
  return `req_${randomUUID().slice(0, 8)}`;
}

export async function cmdPackageApiServer(argv: string[]): Promise<void> {
  const http = await import("http");
  const portArg = argv.find((a) => a.startsWith("--port="));
  const port = portArg ? parseInt(portArg.split("=")[1], 10) : 8080;

  const server = http.createServer(async (req, res) => {
    try {
      if (!requireAuthIfConfigured(req, res)) return;
      const method = req.method || "GET";
      const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const pathname = reqUrl.pathname;
      const actor = asActor(req);
      const requestId = asRequestId(req);
      const store = loadStore();
      const workspace = resolveWorkspace(req, store);

      if (method === "POST" && pathname === `${API_PREFIX}/packages`) {
        const body = normalizeCreateBody(await readJsonBody(req));
        if (!body.name || !body.topic_query || !body.time_window.from || !body.time_window.to) {
          sendJson(res, 400, { error: "Missing required package fields" });
          return;
        }
        const currentPackages = countPackagesForWorkspace(store, workspace.id);
        if (currentPackages >= workspace.entitlements.limits.max_packages) {
          sendMonetizationError(
            res,
            402,
            "QUOTA_EXCEEDED",
            `Package limit reached for plan '${workspace.entitlements.plan}'.`,
            {
              workspace_id: workspace.id,
              limit: workspace.entitlements.limits.max_packages,
              current: currentPackages,
              metric: "max_packages",
            }
          );
          return;
        }
        const packageId = `pkg_${randomUUID().slice(0, 8)}`;
        const jobId = `job_${randomUUID().slice(0, 8)}`;
        const createdAt = nowIso();
        const snapshot: Snapshot = {
          package_id: packageId,
          version: 1,
          created_at: createdAt,
          evidence_count: 0,
          claim_count: 0,
          quality_score: 0.5,
        };
        store.packages[packageId] = {
          id: packageId,
          tenant_id: workspace.id,
          name: body.name,
          topic_query: body.topic_query,
          sources: body.sources,
          policy: (body.policy as PackageRecord["policy"]) || "private",
          analysis_profile: (body.analysis_profile as PackageRecord["analysis_profile"]) || "summary",
          time_window: body.time_window,
          latest_snapshot_version: 1,
          freshness: {
            updated_at: createdAt,
            ttl_seconds: DEFAULT_TTL_SECONDS,
            stale: false,
          },
          snapshots: [snapshot],
        };
        addAuditEvent(store, "package.created", actor, { package_id: packageId, job_id: jobId });
        bumpWorkspaceUsage(workspace, "package_create_count");
        addUsageEvent(store, workspace.id, actor, "package.create", 1, requestId);
        saveStore(store);
        sendJson(res, 202, { package_id: packageId, job_id: jobId, status: "queued" });
        return;
      }

      if (method === "GET" && pathname === `${API_PREFIX}/packages/search`) {
        const q = String(reqUrl.searchParams.get("q") || "").toLowerCase();
        const limit = Math.min(parseInt(reqUrl.searchParams.get("limit") || "20", 10), 100);
        if (!q) {
          sendJson(res, 400, { error: "Missing query param q" });
          return;
        }
        const items = Object.values(store.packages)
          .filter((pkg) => pkg.tenant_id === workspace.id)
          .filter((pkg) => pkg.name.toLowerCase().includes(q) || pkg.topic_query.toLowerCase().includes(q))
          .slice(0, limit)
          .map((pkg) => ({
            package_id: pkg.id,
            name: pkg.name,
            policy: pkg.policy === "shared" ? "shared" : "private",
            freshness: pkg.freshness,
          }));
        addUsageEvent(store, workspace.id, actor, "package.search", 1, requestId);
        saveStore(store);
        sendJson(res, 200, { items });
        return;
      }

      const packageMatch = pathname.match(/^\/v1\/packages\/([^/]+)$/);
      if (method === "GET" && packageMatch) {
        const packageId = decodeURIComponent(packageMatch[1]);
        const pkg = store.packages[packageId];
        if (!pkg || pkg.tenant_id !== workspace.id) {
          sendJson(res, 404, { error: "Package not found" });
          return;
        }
        addUsageEvent(store, workspace.id, actor, "package.status", 1, requestId);
        saveStore(store);
        sendJson(res, 200, pkg);
        return;
      }

      const snapshotsMatch = pathname.match(/^\/v1\/packages\/([^/]+)\/snapshots$/);
      if (method === "GET" && snapshotsMatch) {
        const packageId = decodeURIComponent(snapshotsMatch[1]);
        const pkg = store.packages[packageId];
        if (!pkg || pkg.tenant_id !== workspace.id) {
          sendJson(res, 404, { error: "Package not found" });
          return;
        }
        sendJson(res, 200, { items: pkg.snapshots });
        return;
      }

      const refreshMatch = pathname.match(/^\/v1\/packages\/([^/]+)\/refresh$/);
      if (method === "POST" && refreshMatch) {
        const packageId = decodeURIComponent(refreshMatch[1]);
        const pkg = store.packages[packageId];
        if (!pkg || pkg.tenant_id !== workspace.id) {
          sendJson(res, 404, { error: "Package not found" });
          return;
        }
        const body = (await readJsonBody(req)) as { reason?: string };
        const jobId = `job_${randomUUID().slice(0, 8)}`;
        const nextVersion = pkg.latest_snapshot_version + 1;
        const createdAt = nowIso();
        pkg.latest_snapshot_version = nextVersion;
        pkg.freshness = {
          updated_at: createdAt,
          ttl_seconds: DEFAULT_TTL_SECONDS,
          stale: false,
        };
        pkg.snapshots.push({
          package_id: packageId,
          version: nextVersion,
          created_at: createdAt,
          evidence_count: 0,
          claim_count: 0,
          quality_score: 0.5,
        });
        addAuditEvent(store, "package.refreshed", actor, {
          package_id: packageId,
          job_id: jobId,
          reason: body.reason || "manual",
        });
        bumpWorkspaceUsage(workspace, "package_refresh_count");
        addUsageEvent(store, workspace.id, actor, "package.refresh", 1, requestId);
        saveStore(store);
        sendJson(res, 202, { job_id: jobId, target_snapshot_version: nextVersion });
        return;
      }

      const publishMatch = pathname.match(/^\/v1\/packages\/([^/]+)\/publish$/);
      if (method === "POST" && publishMatch) {
        const packageId = decodeURIComponent(publishMatch[1]);
        const pkg = store.packages[packageId];
        if (!pkg || pkg.tenant_id !== workspace.id) {
          sendJson(res, 404, { error: "Package not found" });
          return;
        }
        if (!workspace.entitlements.features.shared_publish) {
          sendMonetizationError(
            res,
            403,
            "FEATURE_NOT_IN_PLAN",
            `Publishing packages requires a higher plan than '${workspace.entitlements.plan}'.`,
            {
              workspace_id: workspace.id,
              required_feature: "shared_publish",
            }
          );
          return;
        }
        const body = (await readJsonBody(req)) as { snapshot_version?: number };
        const snapshotVersion = Number(body.snapshot_version || pkg.latest_snapshot_version);
        pkg.policy = "shared";
        addAuditEvent(store, "package.published", actor, {
          package_id: packageId,
          snapshot_version: snapshotVersion,
        });
        bumpWorkspaceUsage(workspace, "package_publish_count");
        addUsageEvent(store, workspace.id, actor, "package.publish", 1, requestId);
        saveStore(store);
        sendJson(res, 200, {
          package_id: packageId,
          snapshot_version: snapshotVersion,
          published: true,
        });
        return;
      }

      const unpublishMatch = pathname.match(/^\/v1\/packages\/([^/]+)\/unpublish$/);
      if (method === "POST" && unpublishMatch) {
        const packageId = decodeURIComponent(unpublishMatch[1]);
        const pkg = store.packages[packageId];
        if (!pkg) {
          sendJson(res, 404, { error: "Package not found" });
          return;
        }
        pkg.policy = "private";
        addAuditEvent(store, "package.unpublished", actor, { package_id: packageId });
        saveStore(store);
        sendJson(res, 200, { package_id: packageId, unpublished: true });
        return;
      }

      if (method === "POST" && pathname === `${API_PREFIX}/query`) {
        const body = (await readJsonBody(req)) as {
          query?: string;
          package_ids?: string[];
          max_claims?: number;
          require_citations?: boolean;
        };
        const query = String(body.query || "");
        const packageIds = Array.isArray(body.package_ids) ? body.package_ids : [];
        if (!query || packageIds.length === 0) {
          sendJson(res, 400, { error: "Missing query or package_ids" });
          return;
        }

        const maxClaims = Math.min(
          Number(body.max_claims || 10),
          workspace.entitlements.limits.max_query_claims
        );
        const packages = packageIds
          .map((id) => store.packages[id])
          .filter((pkg): pkg is PackageRecord => Boolean(pkg && pkg.tenant_id === workspace.id));
        if (packages.length === 0) {
          sendJson(res, 404, { error: "No matching packages found" });
          return;
        }

        const claims = packages.slice(0, maxClaims).map((pkg, idx) => ({
          id: `clm_${randomUUID().slice(0, 8)}`,
          text: `Package '${pkg.name}' contains relevant context for query '${query}'.`,
          confidence: Math.max(0.5, 0.85 - idx * 0.05),
          supporting_evidence_ids: [`ev_${pkg.id}_${pkg.latest_snapshot_version}`],
        }));

        const citations = packages.map((pkg) => ({
          evidence_id: `ev_${pkg.id}_${pkg.latest_snapshot_version}`,
          source: pkg.sources[0] || "x_api_v2",
          source_object_id: `${pkg.id}:${pkg.latest_snapshot_version}`,
          url: `https://local.xint.dev/packages/${pkg.id}/snapshots/${pkg.latest_snapshot_version}`,
          captured_at: pkg.freshness.updated_at,
        }));

        const freshness = packages
          .map((pkg) => pkg.freshness.updated_at)
          .sort()[0] || nowIso();

        addAuditEvent(store, "package.query", actor, {
          query,
          package_ids: packageIds,
          claim_count: claims.length,
        });
        bumpWorkspaceUsage(workspace, "package_query_count");
        addUsageEvent(store, workspace.id, actor, "package.query", claims.length, requestId);
        saveStore(store);
        sendJson(res, 200, {
          answer: `Found ${claims.length} claim(s) across ${packages.length} package(s) for query '${query}'.`,
          claims,
          citations,
          freshness: {
            updated_at: freshness,
            ttl_seconds: DEFAULT_TTL_SECONDS,
            stale: false,
          },
          cost: {
            estimated_cost_usd: 0,
          },
        });
        return;
      }

      if (method === "GET" && pathname === `${API_PREFIX}/audit/events`) {
        const limit = Math.min(parseInt(reqUrl.searchParams.get("limit") || "100", 10), 500);
        sendJson(res, 200, { items: store.audit_events.slice(0, limit) });
        return;
      }

      if (method === "GET" && pathname === `${API_PREFIX}/billing/entitlements`) {
        const currentPackages = countPackagesForWorkspace(store, workspace.id);
        sendJson(res, 200, {
          workspace: {
            id: workspace.id,
            name: workspace.name,
          },
          entitlements: workspace.entitlements,
          usage: {
            ...workspace.usage,
            current_package_count: currentPackages,
          },
        });
        return;
      }

      if (method === "GET" && pathname === `${API_PREFIX}/billing/usage`) {
        const days = Math.min(parseInt(reqUrl.searchParams.get("days") || "30", 10), 365);
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        const events = (store.usage_events || []).filter((event) => {
          return event.workspace_id === workspace.id && Date.parse(event.created_at) >= cutoff;
        });
        const byOperation = events.reduce<Record<string, number>>((acc, event) => {
          acc[event.operation] = (acc[event.operation] || 0) + event.units;
          return acc;
        }, {});
        sendJson(res, 200, {
          workspace: { id: workspace.id, name: workspace.name },
          window_days: days,
          event_count: events.length,
          units_by_operation: byOperation,
          current_counters: workspace.usage,
        });
        return;
      }

      if (method === "POST" && pathname === `${API_PREFIX}/governance/delete`) {
        const body = (await readJsonBody(req)) as {
          scope?: { package_id?: string };
          reason?: string;
        };
        const requestId = `gov_${randomUUID().slice(0, 8)}`;
        const packageId = body.scope?.package_id;

        if (packageId && store.packages[packageId]) {
          delete store.packages[packageId];
          addAuditEvent(store, "governance.delete", actor, {
            request_id: requestId,
            package_id: packageId,
            reason: body.reason || "unspecified",
          });
          saveStore(store);
        }

        sendJson(res, 202, { request_id: requestId, status: "accepted" });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error: any) {
      sendJson(res, 500, { error: error?.message || "Internal server error" });
    }
  });

  server.listen(port, () => {
    console.error(`xint package API server running at http://localhost:${port}${API_PREFIX}`);
    console.error(`Store file: ${STORE_PATH}`);
  });
}
