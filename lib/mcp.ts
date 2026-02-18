/**
 * xint MCP Server
 * 
 * MCP (Model Context Protocol) server implementation for xint CLI.
 * Exposes xint functionality as MCP tools for AI agents like Claude Code.
 */

import * as api from "./api";
import * as cache from "./cache";
import { checkBudget, trackCost } from "./costs";
import { recordCommandResult } from "./reliability";

type PolicyMode = "read_only" | "engagement" | "moderation";

interface MCPServerOptions {
  policyMode: PolicyMode;
  enforceBudget: boolean;
}

interface ToolExecutionResult {
  data: unknown;
  fallbackUsed: boolean;
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
    name: "xint_cache_clear",
    description: "Clear the xint search cache",
    inputSchema: {
      type: "object",
      properties: {},
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
  xint_cache_clear: "read_only",
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
class MCPServer {
  private initialized = false;
  private idCounter = 1;
  private readonly options: MCPServerOptions;

  constructor(options: MCPServerOptions) {
    this.options = options;
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
                text: typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2)
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

    switch (name) {
      case "xint_search": {
        const query = String(args.query || "");
        const tweets = await api.search(query, {
          pages: Math.ceil((Number(args.limit) || 15) / 20),
          sortOrder: (args.sort === "recent" ? "recency" : "relevancy") as any,
          since: typeof args.since === "string" ? args.since : undefined,
        });
        let results = tweets;
        if (args.noRetweets) {
          results = results.filter((t: any) => !t.text.startsWith("RT @"));
        }
        if (args.noReplies) {
          results = results.filter((t: any) => t.conversation_id === t.id);
        }
        trackCost("search", "/2/tweets/search/recent", tweets.length);
        return { data: results.slice(0, Number(args.limit) || 15), fallbackUsed: false };
      }

      case "xint_profile": {
        const username = String(args.username || "");
        const count = Number(args.count) || 20;
        const includeReplies = Boolean(args.includeReplies);
        const { user, tweets } = await api.profile(username, {
          count,
          includeReplies,
        });
        trackCost("profile", `/2/users/by/username/${username}`, tweets.length + 1);
        return { data: { user, tweets: tweets.slice(0, count) }, fallbackUsed: false };
      }

      case "xint_thread": {
        const tweetId = this.extractTweetId(String(args.tweetId || ""));
        const pages = Number(args.pages) || 2;
        const tweets = await api.thread(tweetId, { pages });
        trackCost("thread", "/2/tweets/search/recent", tweets.length);
        return { data: { tweets }, fallbackUsed: false };
      }

      case "xint_tweet": {
        const tweetId = this.extractTweetId(String(args.tweetId || ""));
        const tweet = await api.getTweet(tweetId);
        trackCost("tweet", `/2/tweets/${tweetId}`, tweet ? 1 : 0);
        return { data: tweet, fallbackUsed: false };
      }

      case "xint_article": {
        const { fetchArticle } = await import("./article");
        const article = await fetchArticle(String(args.url || ""), { full: args.full !== false });
        return { data: article, fallbackUsed: false };
      }

      case "xint_xsearch": {
        return { data: { note: "xSearch requires XAI_API_KEY" }, fallbackUsed: false };
      }

      case "xint_collections_list": {
        return { data: { note: "Collections requires XAI_API_KEY" }, fallbackUsed: false };
      }

      case "xint_collections_search": {
        return { data: { note: "Collections requires XAI_API_KEY" }, fallbackUsed: false };
      }

      case "xint_analyze": {
        return { data: { note: "Analyze requires XAI_API_KEY" }, fallbackUsed: false };
      }

      case "xint_trends": {
        const { fetchTrends } = await import("./trends");
        const location = typeof args.location === "string" ? args.location : "worldwide";
        const limit = Number(args.limit) || 20;
        const trends = await fetchTrends(location, limit);
        return { data: trends, fallbackUsed: trends.source === "search_fallback" };
      }

      case "xint_bookmarks": {
        return { data: { note: "Bookmarks requires OAuth - use xint bookmarks command" }, fallbackUsed: false };
      }

      case "xint_cache_clear": {
        const removed = cache.clear();
        return { data: { cleared: removed }, fallbackUsed: false };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
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

  console.error("Starting xint MCP server...");
  console.error(`Policy mode: ${policyMode} | Budget guard: ${noBudget ? "disabled" : "enabled"}`);

  if (isSSE) {
    await runSSE(port, { policyMode, enforceBudget: !noBudget });
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

async function runSSE(port: number, options: MCPServerOptions) {
  const http = await import("http");
  const server = new MCPServer(options);

  const httpServer = http.createServer(async (req, res) => {
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

  httpServer.listen(port, () => {
    console.error(`xint MCP server running on http://localhost:${port}`);
    console.error(`SSE endpoint: http://localhost:${port}/sse`);
    console.error(`MCP endpoint: http://localhost:${port}/mcp`);
  });
}

// Run if called directly
if (import.meta.main) {
  cmdMCPServer(process.argv.slice(2)).catch(console.error);
}
