/**
 * xint MCP Server
 * 
 * MCP (Model Context Protocol) server implementation for xint CLI.
 * Exposes xint functionality as MCP tools for AI agents like Claude Code.
 */

import { checkBudget } from "./costs";
import { recordCommandResult } from "./reliability";
import { readFileSync } from "fs";
import { join } from "path";
import { createMcpToolHandlers, type MCPToolHandler, type ToolExecutionResult } from "./mcp_dispatcher";

type PolicyMode = "read_only" | "engagement" | "moderation";

interface MCPServerOptions {
  policyMode: PolicyMode;
  enforceBudget: boolean;
}

interface MCPSSEServerOptions extends MCPServerOptions {
  host: string;
  authToken?: string;
}

interface PackageQueryClaim {
  claim_id: string;
}

interface PackageQueryCitation {
  claim_id: string;
  url: string;
}

function envOrDotEnv(key: string): string | undefined {
  const direct = process.env[key];
  if (direct && direct.trim()) return direct.trim();
  try {
    const envPath = join(import.meta.dir, "..", ".env");
    const raw = readFileSync(envPath, "utf-8");
    const m = raw.match(new RegExp(`^${key}=["']?([^"'\\n]+)`, "m"));
    if (m?.[1]) return m[1].trim();
  } catch {}
  return undefined;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function ensurePackageQueryCitations(data: unknown, requireCitations: boolean): void {
  if (!requireCitations) return;
  const obj = asObject(data);
  if (!obj) {
    throw new Error("Package API query response must be a JSON object.");
  }

  const claimsRaw = obj.claims;
  const citationsRaw = obj.citations;
  const claims = Array.isArray(claimsRaw) ? claimsRaw : [];
  const citations = Array.isArray(citationsRaw) ? citationsRaw : [];

  if (claims.length > 0 && citations.length === 0) {
    throw new Error("Package API query response missing citations while require_citations=true.");
  }

  const claimIds = new Set<string>();
  for (const item of claims) {
    const claim = asObject(item) as PackageQueryClaim | null;
    if (!claim?.claim_id || typeof claim.claim_id !== "string") continue;
    claimIds.add(claim.claim_id);
  }

  if (claimIds.size === 0) return;

  const citedClaimIds = new Set<string>();
  for (const item of citations) {
    const citation = asObject(item) as PackageQueryCitation | null;
    if (!citation) continue;
    if (typeof citation.claim_id !== "string" || !citation.claim_id) continue;
    if (typeof citation.url !== "string" || !citation.url) continue;
    citedClaimIds.add(citation.claim_id);
  }

  for (const claimId of claimIds) {
    if (!citedClaimIds.has(claimId)) {
      throw new Error(
        `Package API query response has uncited claim '${claimId}' while require_citations=true.`
      );
    }
  }
}

// Tool definitions
const TOOLS = [
  {
    name: "xint_search",
    description: "Search recent tweets on X/Twitter with advanced filters",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (e.g., 'AI news', 'from:elonmusk')" },
        limit: { type: "number", description: "Max results to return (default: 15, max: 100)" },
        since: { type: "string", description: "Time filter: 1h, 1d, 7d, 30d (default: 7d)" },
        sort: { type: "string", enum: ["likes", "retweets", "recent", "impressions"], description: "Sort order (default: likes)" },
        noReplies: { type: "boolean", description: "Exclude replies (default: false)" },
        noRetweets: { type: "boolean", description: "Exclude retweets (default: true)" },
      },
      required: ["query"],
    },
  },
  {
    name: "xint_profile",
    description: "Get recent tweets from a specific X/Twitter user",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Twitter username (without @)" },
        count: { type: "number", description: "Number of tweets (default: 20, max: 100)" },
        includeReplies: { type: "boolean", description: "Include replies (default: false)" },
      },
      required: ["username"],
    },
  },
  {
    name: "xint_thread",
    description: "Get full conversation thread from a tweet",
    inputSchema: {
      type: "object",
      properties: {
        tweetId: { type: "string", description: "Tweet ID or URL" },
        pages: { type: "number", description: "Number of pages to fetch (default: 2, max: 5)" },
      },
      required: ["tweetId"],
    },
  },
  {
    name: "xint_tweet",
    description: "Get a single tweet by ID",
    inputSchema: {
      type: "object",
      properties: {
        tweetId: { type: "string", description: "Tweet ID or URL" },
      },
      required: ["tweetId"],
    },
  },
  {
    name: "xint_article",
    description: "Fetch and extract content from a URL article. Also supports X tweet URLs - extracts linked article automatically. Use aiPrompt to analyze with Grok.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Article URL or X tweet URL to fetch" },
        full: { type: "boolean", description: "Fetch full content (default: false)" },
        aiPrompt: { type: "string", description: "Analyze article with Grok AI - ask a question about the content" },
      },
      required: ["url"],
    },
  },
  {
    name: "xint_xsearch",
    description: "Search X using xAI's Grok x-search for AI-powered results",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default: 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "xint_collections_list",
    description: "List all xAI Collections knowledge base collections",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "xint_collections_search",
    description: "Search within an xAI Collections knowledge base",
    inputSchema: {
      type: "object",
      properties: {
        collectionId: { type: "string", description: "Collection ID to search in" },
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default: 5)" },
      },
      required: ["collectionId", "query"],
    },
  },
  {
    name: "xint_analyze",
    description: "Analyze tweets or answer questions using Grok AI",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Question or analysis request" },
        tweets: { type: "array", description: "Array of tweets to analyze (optional)" },
        model: { type: "string", description: "Grok model (grok-3-mini, grok-3, grok-2)" },
      },
      required: ["query"],
    },
  },
  {
    name: "xint_trends",
    description: "Get trending topics on X",
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string", description: "Location name or WOEID (default: worldwide)" },
        limit: { type: "number", description: "Number of trends (default: 20)" },
      },
    },
  },
  {
    name: "xint_bookmarks",
    description: "Get your bookmarked tweets (requires OAuth)",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max bookmarks (default: 20)" },
        since: { type: "string", description: "Filter by recency: 1h, 1d, 7d" },
      },
    },
  },
  {
    name: "xint_package_create",
    description: "Create an agent memory package ingest job (v1 draft contract)",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable package name" },
        topicQuery: { type: "string", description: "Topic query used for ingest and refresh" },
        sources: {
          type: "array",
          items: { type: "string", enum: ["x_api_v2", "xai_search", "web_article"] },
          description: "Data sources to ingest",
        },
        timeWindow: {
          type: "object",
          properties: {
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
          },
          required: ["from", "to"],
        },
        policy: { type: "string", enum: ["private", "shared_candidate"], description: "Package visibility policy" },
        analysisProfile: { type: "string", enum: ["summary", "analyst", "forensic"] },
      },
      required: ["name", "topicQuery", "sources", "timeWindow", "policy", "analysisProfile"],
    },
  },
  {
    name: "xint_package_status",
    description: "Get package metadata and freshness (v1 draft contract)",
    inputSchema: {
      type: "object",
      properties: {
        packageId: { type: "string", description: "Package identifier (pkg_*)" },
      },
      required: ["packageId"],
    },
  },
  {
    name: "xint_package_query",
    description: "Query one or more packages and return claims with citations (v1 draft contract)",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Question to ask over package memory" },
        packageIds: {
          type: "array",
          items: { type: "string" },
          description: "Package IDs included in retrieval scope",
        },
        maxClaims: { type: "number", description: "Maximum number of claims (default: 10)" },
        requireCitations: { type: "boolean", description: "Require citations in response (default: true)" },
      },
      required: ["query", "packageIds"],
    },
  },
  {
    name: "xint_package_refresh",
    description: "Trigger package refresh and create a new snapshot (v1 draft contract)",
    inputSchema: {
      type: "object",
      properties: {
        packageId: { type: "string", description: "Package identifier" },
        reason: { type: "string", enum: ["ttl", "manual", "event"] },
      },
      required: ["packageId", "reason"],
    },
  },
  {
    name: "xint_package_search",
    description: "Search private and shared package catalog (v1 draft contract)",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query for package catalog" },
        limit: { type: "number", description: "Max packages to return (default: 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "xint_package_publish",
    description: "Publish a package snapshot to shared catalog (v1 draft contract)",
    inputSchema: {
      type: "object",
      properties: {
        packageId: { type: "string", description: "Package identifier" },
        snapshotVersion: { type: "number", description: "Snapshot version to publish" },
      },
      required: ["packageId", "snapshotVersion"],
    },
  },
  {
    name: "xint_cache_clear",
    description: "Clear the xint search cache",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "xint_costs",
    description: "Get API cost tracking information",
    inputSchema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["today", "week", "month", "all"],
          description: "Time period (default: today)",
        },
      },
    },
  },
];

const TOOL_POLICY: Record<string, PolicyMode> = {
  xint_search: "read_only",
  xint_profile: "read_only",
  xint_thread: "read_only",
  xint_tweet: "read_only",
  xint_article: "read_only",
  xint_xsearch: "read_only",
  xint_collections_list: "read_only",
  xint_collections_search: "read_only",
  xint_analyze: "read_only",
  xint_trends: "read_only",
  xint_bookmarks: "engagement",
  xint_package_create: "read_only",
  xint_package_status: "read_only",
  xint_package_query: "read_only",
  xint_package_refresh: "read_only",
  xint_package_search: "read_only",
  xint_package_publish: "engagement",
  xint_cache_clear: "read_only",
  xint_costs: "read_only",
};

const TOOL_BUDGET_GUARDED = new Set<string>([
  "xint_search",
  "xint_profile",
  "xint_thread",
  "xint_tweet",
  "xint_trends",
  "xint_xsearch",
  "xint_collections_list",
  "xint_collections_search",
  "xint_analyze",
  "xint_bookmarks",
  "xint_package_create",
  "xint_package_query",
  "xint_package_refresh",
  "xint_package_search",
  "xint_package_publish",
]);

function policyRank(mode: PolicyMode): number {
  switch (mode) {
    case "read_only": return 1;
    case "engagement": return 2;
    case "moderation": return 3;
  }
}

function parsePolicyMode(raw?: string): PolicyMode {
  if (raw === "engagement" || raw === "moderation") return raw;
  return "read_only";
}

// MCP Server implementation
export class MCPServer {
  private initialized = false;
  private idCounter = 1;
  private readonly options: MCPServerOptions;
  private readonly toolHandlers: Record<string, MCPToolHandler>;

  constructor(options: MCPServerOptions) {
    this.options = options;
    this.toolHandlers = createMcpToolHandlers({
      extractTweetId: (input) => this.extractTweetId(input),
      callPackageApi: (method, path, body) => this.callPackageApi(method, path, body),
      ensurePackageQueryCitations: (data, requireCitations) =>
        ensurePackageQueryCitations(data, requireCitations),
    });
  }

  async handleMessage(msg: string): Promise<string | null> {
    let request: any;
    try {
      request = JSON.parse(msg);
    } catch {
      return JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" }
      });
    }

    const { method, params, id } = request;
    const requestId = id ?? this.idCounter++;
    const toolStartedAtMs = method === "tools/call" ? Date.now() : 0;

    try {
      switch (method) {
        case "initialize": {
          this.initialized = true;
          return JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "xint", version: "1.0.0" }
            }
          });
        }

        case "initialized":
          return null;

        case "tools/list":
          return JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            result: { tools: TOOLS }
          });

        case "tools/call": {
          const toolName = params?.name;
          const args = params?.arguments || {};
          const result = await this.executeTool(toolName, args);
          recordCommandResult(
            `mcp:${toolName}`,
            true,
            Date.now() - toolStartedAtMs,
            { mode: "mcp", fallback: result.fallbackUsed },
          );
          return JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            result: {
              content: [{
                type: "text",
                text: JSON.stringify(
                  {
                    type: result.type,
                    message: result.message,
                    data: result.data,
                  },
                  null,
                  2,
                )
              }]
            }
          });
        }

        default:
          return JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            error: { code: -32601, message: `Method not found: ${method}` }
          });
      }
    } catch (error: any) {
      if (method === "tools/call" && params?.name) {
        recordCommandResult(
          `mcp:${params.name}`,
          false,
          Math.max(0, Date.now() - toolStartedAtMs),
          { mode: "mcp" },
        );
      }
      return JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        error: { code: -32603, message: error.message }
      });
    }
  }

  private extractTweetId(input: string): string {
    const urlMatch = input.match(/status\/(\d+)/);
    if (urlMatch) return urlMatch[1];
    return input;
  }

  private ensurePolicyAllowed(name: string): void {
    const required = TOOL_POLICY[name] || "read_only";
    if (policyRank(this.options.policyMode) >= policyRank(required)) return;
    throw new Error(
      JSON.stringify({
        code: "POLICY_DENIED",
        message: `MCP tool '${name}' requires '${required}' policy mode`,
        policy_mode: this.options.policyMode,
        required_mode: required,
      }),
    );
  }

  private ensureBudgetAllowed(name: string): void {
    if (!this.options.enforceBudget) return;
    if (!TOOL_BUDGET_GUARDED.has(name)) return;
    const budget = checkBudget();
    if (budget.allowed) return;
    throw new Error(
      JSON.stringify({
        code: "BUDGET_DENIED",
        message: `Daily budget exceeded ($${budget.spent.toFixed(2)} / $${budget.limit.toFixed(2)})`,
        spent_usd: budget.spent,
        limit_usd: budget.limit,
        remaining_usd: budget.remaining,
      }),
    );
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    this.ensurePolicyAllowed(name);
    this.ensureBudgetAllowed(name);
    const handler = this.toolHandlers[name];
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return handler(args);
  }

  private async callPackageApi(method: string, path: string, body?: unknown): Promise<unknown> {
    const baseUrl = envOrDotEnv("XINT_PACKAGE_API_BASE_URL");
    if (!baseUrl) {
      throw new Error(
        "XINT_PACKAGE_API_BASE_URL not set. Start xint-cloud service on :8787 and set XINT_PACKAGE_API_BASE_URL=http://localhost:8787/v1"
      );
    }
    const apiKey = envOrDotEnv("XINT_PACKAGE_API_KEY");
    const workspaceId = envOrDotEnv("XINT_WORKSPACE_ID");
    const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (workspaceId) headers["x-workspace-id"] = workspaceId;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      let message = `Package API ${res.status}: ${text.slice(0, 300)}`;
      try {
        const parsed = JSON.parse(text) as {
          error?: string;
          code?: string;
          details?: Record<string, unknown>;
        };
        const code = parsed.code || "UNKNOWN";
        const apiError = parsed.error || "Package API request failed";
        message = `Package API ${res.status} [${code}]: ${apiError}`;
        if (code === "PLAN_REQUIRED" || code === "QUOTA_EXCEEDED" || code === "FEATURE_NOT_IN_PLAN") {
          const upgradeUrl =
            envOrDotEnv("XINT_BILLING_UPGRADE_URL") || "https://xint.dev/pricing";
          message = `${message}. Upgrade: ${upgradeUrl}`;
          const feature = parsed.details?.required_feature;
          if (typeof feature === "string" && feature) {
            message = `${message} (required_feature=${feature})`;
          }
        }
      } catch {
        // non-json response; keep text slice
      }
      throw new Error(message);
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return res.json();
    }
    return { ok: true };
  }
}

// CLI entry point
export async function cmdMCPServer(args: string[]) {
  const isSSE = args.includes("--sse");
  const noBudget = args.includes("--no-budget-guard");
  const policyArg = args.find((arg) => arg.startsWith("--policy="));
  const policyMode = parsePolicyMode(policyArg?.split("=")[1] || process.env.XINT_POLICY_MODE);
  const portArg = args.find(a => a.startsWith("--port="));
  const port = portArg ? parseInt(portArg.split("=")[1]) : 3000;
  const hostArg = args.find((arg) => arg.startsWith("--host="));
  const host = hostArg?.split("=")[1] || process.env.XINT_MCP_HOST || "127.0.0.1";
  const authTokenArg = args.find((arg) => arg.startsWith("--auth-token="));
  const authToken = authTokenArg?.split("=")[1] || process.env.XINT_MCP_AUTH_TOKEN;

  console.error("Starting xint MCP server...");
  console.error(`Policy mode: ${policyMode} | Budget guard: ${noBudget ? "disabled" : "enabled"}`);

  if (isSSE) {
    if (host !== "127.0.0.1" && host !== "localhost" && !authToken) {
      throw new Error(
        "Refusing non-loopback MCP bind without auth token. Set XINT_MCP_AUTH_TOKEN or pass --auth-token=<token>."
      );
    }
    await runSSE(port, { policyMode, enforceBudget: !noBudget, host, authToken });
  } else {
    await runStdio({ policyMode, enforceBudget: !noBudget });
  }
}

async function runStdio(options: MCPServerOptions) {
  const server = new MCPServer(options);
  
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      const response = await server.handleMessage(line);
      if (response) {
        console.log(response);
      }
    } catch (e: any) {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: e.message }
      }));
    }
  });
}

function hasValidBearerToken(authHeader: string | undefined, expectedToken: string): boolean {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  return authHeader.slice("Bearer ".length).trim() === expectedToken;
}

async function runSSE(port: number, options: MCPSSEServerOptions) {
  const http = await import("http");
  const server = new MCPServer({
    policyMode: options.policyMode,
    enforceBudget: options.enforceBudget,
  });

  const httpServer = http.createServer(async (req, res) => {
    if (options.authToken && !hasValidBearerToken(req.headers.authorization, options.authToken)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    if (req.url === "/sse") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write("event: connected\ndata: {\"status\":\"connected\"}\n\n");
      
      const interval = setInterval(() => {
        res.write(": keepalive\n\n");
      }, 30000);
      
      req.on("close", () => clearInterval(interval));
      
    } else if (req.url === "/mcp" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        try {
          const response = await server.handleMessage(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(response || "{}");
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  httpServer.listen(port, options.host, () => {
    console.error(`xint MCP server running on http://${options.host}:${port}`);
    console.error(`SSE endpoint: http://${options.host}:${port}/sse`);
    console.error(`MCP endpoint: http://${options.host}:${port}/mcp`);
    if (options.authToken) {
      console.error("Auth: enabled (Bearer token)");
    } else {
      console.error("Auth: disabled (local bind only)");
    }
  });
}

// Run if called directly
if (import.meta.main) {
  cmdMCPServer(process.argv.slice(2)).catch(console.error);
}
