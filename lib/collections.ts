/**
 * lib/collections.ts — xAI Collections Knowledge Base integration
 *
 * Uses xAI's APIs:
 * - api.x.ai (XAI_API_KEY): files, search
 * - management-api.x.ai (XAI_MANAGEMENT_API_KEY): collections management
 */

import { readFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Collection {
  id: string;
  name: string;
  description?: string;
  created_at?: string;
}

export interface FileUploadResponse {
  id: string;
  filename: string;
  purpose: string;
  status: string;
}

export interface DocumentSearchResult {
  id: string;
  content?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface CollectionsListResponse {
  data: Collection[];
}

export interface DocumentSearchResponse {
  results: DocumentSearchResult[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = "https://api.x.ai/v1";
const MGMT_BASE = "https://management-api.x.ai/v1";

/** Normalize xAI API response to our Collection interface (handles collection_id/collection_name fields) */
function normalizeCollection(raw: unknown): Collection {
  const r = raw as Record<string, unknown>;
  return {
    id: (r.id || r.collection_id || "") as string,
    name: (r.name || r.collection_name || "") as string,
    description: (r.description || undefined) as string | undefined,
    created_at: (r.created_at || undefined) as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function readEnvKey(varName: string): string | undefined {
  if (process.env[varName]) return process.env[varName];
  // Check .env.local first (overrides), then .env
  for (const file of [".env.local", ".env"]) {
    try {
      const envFile = readFileSync(join(import.meta.dir, "..", file), "utf-8");
      const re = new RegExp(`${varName}=["']?([^"'\\n]+)`);
      const match = envFile.match(re);
      if (match && !match[1].startsWith("your-")) return match[1];
    } catch {}
  }
  return undefined;
}

function getXaiKey(): string {
  const key = readEnvKey("XAI_API_KEY");
  if (key) return key;
  throw new Error("XAI_API_KEY not found. Set it in your environment or in .env");
}

function getMgmtKey(): string {
  const key = readEnvKey("XAI_MANAGEMENT_API_KEY");
  if (key) return key;

  throw new Error("XAI_MANAGEMENT_API_KEY not found. Set it in your environment or in .env");
}

// ---------------------------------------------------------------------------
// Collections API (Management)
// ---------------------------------------------------------------------------

/**
 * List all collections.
 */
export async function collectionsList(): Promise<CollectionsListResponse> {
  const key = getMgmtKey();

  const res = await fetch(`${MGMT_BASE}/collections`, {
    headers: {
      Authorization: `Bearer ${key}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`xAI API error (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const rawList = (data.data || data.collections || []) as unknown[];
  return { data: rawList.map(normalizeCollection) };
}

/**
 * Create a collection.
 */
export async function collectionsCreate(
  name: string,
  description: string = ""
): Promise<Collection> {
  const key = getMgmtKey();

  const body: Record<string, string> = { collection_name: name };
  if (description) {
    body.description = description;
  }

  const res = await fetch(`${MGMT_BASE}/collections`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`xAI API error (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = await res.json() as Record<string, unknown>;
  return normalizeCollection(data.collection || data.data || data);
}

/**
 * Ensure a collection exists (create if not present).
 */
export async function collectionsEnsure(
  name: string,
  description: string = ""
): Promise<{ collection: Collection; created: boolean }> {
  const list = await collectionsList();

  // Check if exists
  const existing = (list.data || []).find((c) => c.name === name);
  if (existing) {
    return { collection: existing, created: false };
  }

  // Create new
  const created = await collectionsCreate(name, description);
  return { collection: created, created: true };
}

/**
 * Add an already-uploaded document to a collection by ID.
 */
export async function collectionsAddDocument(
  collectionId: string,
  documentId: string
): Promise<unknown> {
  const key = getMgmtKey();

  // Management API requires multipart form for this endpoint
  const proc = Bun.spawn([
    "curl", "-s",
    "-X", "POST",
    `${MGMT_BASE}/collections/${collectionId}/documents`,
    "-H", `Authorization: Bearer ${key}`,
    "-F", `document_id=${documentId}`,
  ], { stdout: "pipe", stderr: "pipe" });

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  if (!output.trim()) {
    throw new Error("Empty response from xAI management API");
  }

  const data = JSON.parse(output.trim());
  if (data.code || data.message) {
    throw new Error(`xAI API error: ${data.message || output.slice(0, 300)}`);
  }

  return data;
}

/**
 * Upload a file directly to a collection (file + metadata in one call).
 */
export async function collectionsUploadDocument(
  collectionId: string,
  filePath: string,
  name: string,
  contentType: string = "text/markdown"
): Promise<unknown> {
  const key = getMgmtKey();

  const proc = Bun.spawn([
    "curl", "-s",
    "-X", "POST",
    `${MGMT_BASE}/collections/${collectionId}/documents`,
    "-H", `Authorization: Bearer ${key}`,
    "-F", `file=@${filePath}`,
    "-F", `data=@${filePath}`,
    "-F", `name=${name}`,
    "-F", `content_type=${contentType}`,
  ], { stdout: "pipe", stderr: "pipe" });

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  if (!output.trim()) {
    throw new Error("Empty response from xAI management API");
  }

  const data = JSON.parse(output.trim());
  if (data.code || data.message) {
    throw new Error(`xAI API error: ${data.message || output.slice(0, 300)}`);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Files API
// ---------------------------------------------------------------------------

/**
 * Upload a file to xAI.
 */
export async function filesUpload(
  filePath: string,
  purpose: string = "assistants"
): Promise<FileUploadResponse> {
  const key = getXaiKey();

  const filename = filePath.split("/").pop() || "file";

  const proc = Bun.spawn([
    "curl", "-s",
    "-X", "POST",
    `${API_BASE}/files`,
    "-H", `Authorization: Bearer ${key}`,
    "-F", `file=@${filePath};filename=${filename}`,
    "-F", `purpose=${purpose}`,
  ], { stdout: "pipe", stderr: "pipe" });

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  if (!output.trim()) {
    throw new Error("Empty response from xAI files API");
  }

  const data = JSON.parse(output.trim()) as Record<string, unknown>;
  if ((data as any).error || (data as any).code) {
    throw new Error(`xAI API error: ${output.slice(0, 500)}`);
  }

  const result = (data.data || data) as FileUploadResponse;
  return result;
}

// ---------------------------------------------------------------------------
// Documents Search API
// ---------------------------------------------------------------------------

/**
 * Search documents in collections.
 */
export async function documentsSearch(
  query: string,
  collectionIds: string[] = [],
  topK: number = 8
): Promise<DocumentSearchResponse> {
  const key = getXaiKey();

  const body: Record<string, unknown> = {
    query,
    top_k: topK,
    source: "user_upload",
  };

  if (collectionIds.length > 0) {
    body.collection_ids = collectionIds;
  }

  const res = await fetch(`${API_BASE}/documents/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`xAI API error (${res.status}): ${text.slice(0, 500)}`);
  }

  return res.json() as Promise<DocumentSearchResponse>;
}

// ---------------------------------------------------------------------------
// CLI Handler
// ---------------------------------------------------------------------------

export async function cmdCollections(args: string[]): Promise<void> {
  const subcommand = args[0] || "help";

  try {
    switch (subcommand) {
      case "list":
        await cmdList();
        break;
      case "create":
        await cmdCreate(args.slice(1));
        break;
      case "ensure":
        await cmdEnsure(args.slice(1));
        break;
      case "add-document":
      case "add-doc":
        await cmdAddDocument(args.slice(1));
        break;
      case "upload":
        await cmdUpload(args.slice(1));
        break;
      case "search":
        await cmdSearch(args.slice(1));
        break;
      case "sync-dir":
      case "sync":
        await cmdSyncDir(args.slice(1));
        break;
      case "help":
      case "--help":
      case "-h":
        printHelp();
        break;
      default:
        console.error(`Unknown subcommand: ${subcommand}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}

async function cmdList(): Promise<void> {
  const res = await collectionsList();
  console.log(JSON.stringify(res, null, 2));
}

async function cmdCreate(args: string[]): Promise<void> {
  const name = getFlag(args, "--name");
  const description = getFlag(args, "--description") || "";

  if (!name) {
    console.error("Error: --name required");
    process.exit(1);
  }

  const collection = await collectionsCreate(name, description);
  console.log(JSON.stringify(collection, null, 2));
}

async function cmdEnsure(args: string[]): Promise<void> {
  const name = getFlag(args, "--name");
  const description = getFlag(args, "--description") || "";

  if (!name) {
    console.error("Error: --name required");
    process.exit(1);
  }

  const result = await collectionsEnsure(name, description);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdAddDocument(args: string[]): Promise<void> {
  const collectionId = getFlag(args, "--collection-id");
  const documentId = getFlag(args, "--document-id");

  if (!collectionId || !documentId) {
    console.error("Error: --collection-id and --document-id required");
    process.exit(1);
  }

  const result = await collectionsAddDocument(collectionId, documentId);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdUpload(args: string[]): Promise<void> {
  const path = getFlag(args, "--path");
  const purpose = getFlag(args, "--purpose") || "kb_sync";

  if (!path) {
    console.error("Error: --path required");
    process.exit(1);
  }

  const result = await filesUpload(path, purpose);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdSearch(args: string[]): Promise<void> {
  const query = getFlag(args, "--query");
  const collectionIdsStr = getFlag(args, "--collection-ids") || "";
  const topK = parseInt(getFlag(args, "--top-k") || "8");

  if (!query) {
    console.error("Error: --query required");
    process.exit(1);
  }

  const collectionIds = collectionIdsStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const result = await documentsSearch(query, collectionIds, topK);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdSyncDir(args: string[]): Promise<void> {
  const collectionName = getFlag(args, "--collection-name") || getFlag(args, "--name");
  const dir = getFlag(args, "--dir");
  const globs = args.filter((a) => a.startsWith("--glob")).map((a) => a.replace("--glob=", "").replace("--glob", ""));
  const limit = parseInt(getFlag(args, "--limit") || "50");
  const purpose = getFlag(args, "--purpose") || "kb_sync";
  const reportMd = getFlag(args, "--report-md");

  if (!collectionName || !dir) {
    console.error("Error: --collection-name and --dir required");
    process.exit(1);
  }

  const directory = Bun.spawnSync(["ls", dir]);
  if (!directory.success) {
    console.error(`Error: Directory not found: ${dir}`);
    process.exit(1);
  }

  // Ensure collection
  console.log(`Ensuring collection '${collectionName}'...`);
  const { collection, created } = await collectionsEnsure(collectionName, "xint KB sync");
  const collectionId = collection.id;

  if (created) {
    console.log(`Created new collection: ${collectionName}`);
  } else {
    console.log(`Using existing collection: ${collectionName}`);
  }

  // Find files
  const files: string[] = [];
  const globPatterns = globs.length > 0 ? globs : ["*.md"];

  for (const pattern of globPatterns) {
    const result = Bun.spawnSync(["find", dir, "-name", pattern, "-type", "f"]);
    if (result.success && result.stdout) {
      const fileList = new TextDecoder().decode(result.stdout).trim().split("\n");
      files.push(...fileList.filter(Boolean));
    }
  }

  // Dedupe
  const uniqueFiles = [...new Set(files)].slice(0, limit);
  console.log(`Found ${uniqueFiles.length} files matching ${globPatterns.join(", ")}`);

  // Upload and attach
  let uploaded = 0;
  let attached = 0;
  const failures: string[] = [];

  for (const filePath of uniqueFiles) {
    try {
      console.log(`  Uploading ${filePath.split("/").pop()}...`);
      const upRes = await filesUpload(filePath, purpose);
      uploaded++;

      if (collectionId) {
        try {
          await collectionsAddDocument(collectionId, upRes.id);
          attached++;
          console.log(`    Uploaded + attached`);
        } catch (e: any) {
          console.log(`    Uploaded (attach failed: ${e.message})`);
          failures.push(`${filePath}: attach error`);
        }
      }
    } catch (e: any) {
      console.log(`    FAILED: ${e.message}`);
      failures.push(`${filePath}: ${e.message}`);
    }
  }

  // Write report
  const ts = new Date().toISOString();
  const reportPath = reportMd || `${dir}/xai-collections-sync-latest.md`;

  const lines: string[] = [];
  lines.push("# xAI Collections KB Sync");
  lines.push("");
  lines.push(`- Timestamp (UTC): ${ts}`);
  lines.push(`- Collection name: \`${collectionName}\``);
  lines.push(`- Directory: \`${dir}\``);
  lines.push(`- Globs: \`${globPatterns.join(", ")}\``);
  lines.push(`- Limit: ${limit}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Files considered: ${uniqueFiles.length}`);
  lines.push(`- Upload attempts: ${uploaded}`);
  lines.push(`- Attach attempts: ${attached}`);
  lines.push(`- Failures: ${failures.length}`);
  lines.push("");

  if (failures.length > 0) {
    lines.push("## Failures");
    lines.push("");
    for (const f of failures.slice(0, 50)) {
      lines.push(`- ${f}`);
    }
    lines.push("");
  }

  await Bun.write(reportPath, lines.join("\n"));

  console.log(`\nSync complete: ${uploaded} uploaded, ${attached} attached, ${failures.length} failures`);
  console.log(`Report: ${reportPath}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  // Also check flag=value format
  for (const arg of args) {
    if (arg.startsWith(flag + "=")) {
      return arg.slice(flag.length + 1);
    }
  }
  return undefined;
}

function printHelp(): void {
  console.log(`
xAI Collections Knowledge Base

Usage: xint collections <subcommand> [options]

Subcommands:
  list                                List all collections
  create --name <name> [--description <desc>]  Create a collection
  ensure --name <name> [--description <desc>]  Create if doesn't exist
  add-document --collection-id <id> --document-id <id>  Attach document
  upload --path <file> [--purpose <p>]        Upload a file
  search --query <q> [--collection-ids <ids>]  Search documents
  sync-dir --collection-name <n> --dir <path>  Sync directory to collection

Options:
  --collection-name <name>       Collection name
  --description <desc>           Collection description
  --collection-id <id>           Collection ID
  --document-id <id>             Document/file ID
  --path <file>                  File path to upload
  --purpose <purpose>            Upload purpose (default: kb_sync)
  --query <query>                Search query
  --collection-ids <ids>          Comma-separated collection IDs
  --top-k <N>                     Number of results (default: 8)
  --dir <path>                   Directory to sync
  --glob <pattern>                File glob pattern (default: *.md)
  --limit <N>                    Max files to upload (default: 50)
  --report-md <path>             Report output path

Env vars:
  XAI_API_KEY                     File upload + document search
  XAI_MANAGEMENT_API_KEY          Collections management
`);
}
