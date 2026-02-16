/**
 * lib/x_search.ts — xAI x_search integration
 *
 * Uses xAI's Responses API with the x_search tool to search X/Twitter
 * without needing cookies or GraphQL scraping.
 */

import { readFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface XSearchResult {
  url?: string;
  tweet_url?: string;
  link?: string;
  text?: string;
  content?: string;
  snippet?: string;
  title?: string;
  username?: string;
  author?: string;
  handle?: string;
  created_at?: string;
  date?: string;
  timestamp?: string;
}

export interface XSearchOptions {
  maxResults?: number;
  fromDate?: string;  // YYYY-MM-DD
  toDate?: string;   // YYYY-MM-DD
  model?: string;
  timeoutSeconds?: number;
}

export interface XSearchResponse {
  results: XSearchResult[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-4";
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_TIMEOUT = 45;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function getXaiKey(): string {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;

  try {
    const envFile = readFileSync(join(import.meta.dir, "..", ".env"), "utf-8");
    const match = envFile.match(/XAI_API_KEY=["']?([^"'\n]+)/);
    if (match) return match[1];
  } catch {}

  throw new Error("XAI_API_KEY not found. Set it in your environment or in .env");
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

function bestUrl(r: XSearchResult): string {
  return r.url || r.tweet_url || r.link || "";
}

function bestText(r: XSearchResult): string {
  const text = r.text || r.content || r.snippet || r.title || "";
  return text.trim();
}

function bestHandle(r: XSearchResult): string {
  const handle = r.username || r.author || r.handle || "";
  return handle.replace(/^@/, "").trim();
}

function bestCreatedAt(r: XSearchResult): string {
  return r.created_at || r.date || r.timestamp || "";
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Search X using xAI's hosted x_search tool.
 */
export async function xSearch(
  query: string,
  opts: XSearchOptions = {}
): Promise<XSearchResponse> {
  const apiKey = getXaiKey();
  const model = opts.model || DEFAULT_MODEL;
  const maxResults = opts.maxResults || DEFAULT_MAX_RESULTS;
  const timeout = (opts.timeoutSeconds || DEFAULT_TIMEOUT) * 1000;

  // Build tool spec
  const toolSpec: Record<string, unknown> = {
    type: "x_search",
    max_results: maxResults,
  };
  if (opts.fromDate) {
    toolSpec["from_date"] = opts.fromDate;
  }
  if (opts.toDate) {
    toolSpec["to_date"] = opts.toDate;
  }

  const body = {
    model,
    input: `Use x_search to find recent posts relevant to: ${query}\nReturn the search results.`,
    tools: [toolSpec],
    tool_choice: "required",
    max_output_tokens: 800,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${API_BASE}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (res.status === 401) {
      throw new Error("xAI auth failed (401). Check your XAI_API_KEY.");
    }
    if (res.status === 402) {
      throw new Error("xAI payment required (402). Your account may be out of credits.");
    }
    if (res.status === 429) {
      throw new Error("xAI rate limited (429). Try again in a moment.");
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`xAI API error (${res.status}): ${text.slice(0, 500)}`);
    }

    const data = await res.json() as {
      output?: Array<{
        type?: string;
        results?: XSearchResult[];
        content?: Array<{ type?: string; text?: string }>;
      }>;
    };

    // Extract results and summary
    const results: XSearchResult[] = [];
    let summary = "";

    const output = data.output || [];
    for (const item of output) {
      if (item.type === "x_search_call") {
        const r = item.results;
        if (Array.isArray(r)) {
          results.push(...r);
        }
      }

      if (item.type === "message") {
        const content = item.content || [];
        for (const part of content) {
          if (part.type === "output_text" && part.text) {
            summary = part.text.trim();
          }
        }
      }
    }

    return { results, summary };
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// CLI Handler
// ---------------------------------------------------------------------------

export async function cmdXSearch(args: string[]): Promise<void> {
  const queriesFile = args[0];
  const outJson = args[1];
  const outMd = args[2];
  const opts: XSearchOptions = {
    maxResults: 10,
    model: DEFAULT_MODEL,
    timeoutSeconds: DEFAULT_TIMEOUT,
  };

  // Parse remaining args
  for (let i = 3; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--max-results":
        opts.maxResults = parseInt(args[++i]) || 10;
        break;
      case "--model":
        opts.model = args[++i];
        break;
      case "--from-date":
        opts.fromDate = args[++i];
        break;
      case "--to-date":
        opts.toDate = args[++i];
        break;
    }
  }

  if (!queriesFile) {
    console.error("Usage: xint x_search <queries_file> <out_json> <out_md> [options]");
    console.error("Options:");
    console.error("  --max-results N    Max results per query (default: 10)");
    console.error("  --model <name>    Model (default: grok-4)");
    console.error("  --from-date YYYY-MM-DD");
    console.error("  --to-date YYYY-MM-DD");
    process.exit(1);
  }

  // Load queries
  let queries: string[];
  try {
    const content = await Bun.file(queriesFile).text();
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      queries = parsed.filter((q: unknown) => typeof q === "string" && q.trim());
    } else if (parsed.queries && Array.isArray(parsed.queries)) {
      queries = parsed.queries.filter((q: unknown) => typeof q === "string" && q.trim());
    } else {
      throw new Error("Invalid queries file format");
    }
  } catch (e: any) {
    console.error(`Error loading queries: ${e.message}`);
    process.exit(1);
  }

  if (queries.length === 0) {
    console.error("No queries provided.");
    process.exit(1);
  }

  const ts = new Date().toISOString().replace("Z", "Z");
  const perQuery: Array<{
    query: string;
    results: XSearchResult[];
    summary: string;
    error?: string;
  }> = [];
  let hadErrors = false;

  console.log(`Running x_search for ${queries.length} query(s)...`);

  for (const q of queries) {
    try {
      const { results, summary } = await xSearch(q, opts);
      perQuery.push({ query: q, results, summary });
      console.log(`  "${q}": ${results.length} results`);
    } catch (e: any) {
      hadErrors = true;
      perQuery.push({
        query: q,
        results: [],
        summary: "",
        error: e.message.slice(0, 500),
      });
      console.error(`  "${q}": ERROR - ${e.message.slice(0, 100)}`);
    }
  }

  // Build JSON payload
  const jsonPayload = {
    timestamp: ts,
    model: opts.model,
    max_results: opts.maxResults,
    from_date: opts.fromDate,
    to_date: opts.toDate,
    queries: perQuery.map((pq) => ({
      query: pq.query,
      summary: pq.summary,
      results: pq.results.map((r) => ({
        url: bestUrl(r),
        text: bestText(r),
        username: bestHandle(r),
        created_at: bestCreatedAt(r),
      })),
      error: pq.error,
    })),
  };

  // Write JSON output
  if (outJson) {
    try {
      await Bun.write(outJson, JSON.stringify(jsonPayload, null, 2) + "\n");
      console.log(`JSON: ${outJson}`);
    } catch (e: any) {
      console.error(`Error writing JSON: ${e.message}`);
    }
  }

  // Write markdown report
  if (outMd) {
    const md = renderMarkdown(ts, queries, perQuery);
    try {
      await Bun.write(outMd, md);
      console.log(`Report: ${outMd}`);
    } catch (e: any) {
      console.error(`Error writing markdown: ${e.message}`);
    }
  }

  // Summary
  const totalResults = perQuery.reduce((sum, pq) => sum + pq.results.length, 0);
  const status = hadErrors && totalResults === 0 ? "FAIL" : hadErrors ? "PARTIAL" : "OK";
  console.log(`\nxAI X search: ${status} (${queries.length} queries, ${totalResults} results)`);
}

// ---------------------------------------------------------------------------
// Markdown Rendering
// ---------------------------------------------------------------------------

function renderMarkdown(
  ts: string,
  queries: string[],
  perQuery: Array<{
    query: string;
    results: XSearchResult[];
    summary: string;
    error?: string;
  }>
): string {
  const lines: string[] = [];
  lines.push("# xAI X Search Scan");
  lines.push("");
  lines.push(`- Timestamp (UTC): ${ts}`);
  lines.push(`- Queries: ${queries.length}`);
  lines.push("");

  // Find combined summary (prefer last non-empty)
  const combinedSummary = perQuery
    .slice()
    .reverse()
    .find((pq) => pq.summary.trim())?.summary || "";

  if (combinedSummary) {
    lines.push("## Summary");
    lines.push("");
    lines.push(combinedSummary.trim());
    lines.push("");
  }

  lines.push("## Results");
  lines.push("");

  for (const pq of perQuery) {
    lines.push(`### Query: \`${pq.query}\``);
    lines.push("");

    if (pq.error) {
      lines.push(`- ERROR: ${pq.error}`);
      lines.push("");
      continue;
    }

    if (pq.results.length === 0) {
      lines.push("- (no results)");
      lines.push("");
      continue;
    }

    for (const r of pq.results) {
      const handle = bestHandle(r);
      let text = bestText(r).replace(/\n/g, " ");
      if (text.length > 220) {
        text = text.slice(0, 217) + "...";
      }
      const url = bestUrl(r);
      const createdAt = bestCreatedAt(r);

      const prefix = handle ? `@${handle}: ` : "";
      const meta = createdAt ? ` (${createdAt})` : "";

      if (url) {
        lines.push(`- ${prefix}${text}${meta} ${url}`);
      } else {
        lines.push(`- ${prefix}${text}${meta}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ---------------------------------------------------------------------------
// Utility Exports
// ---------------------------------------------------------------------------

export { bestUrl, bestText, bestHandle, bestCreatedAt };
