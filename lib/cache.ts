/**
 * Simple file-based cache for X API results.
 * Avoids re-fetching identical queries within a TTL window.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import type { Tweet } from "./api";

const CACHE_DIR = join(import.meta.dir, "..", "data", "cache");
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

function ensureDir() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheKey(query: string, params: string = ""): string {
  const hash = createHash("md5")
    .update(`${query}|${params}`)
    .digest("hex")
    .slice(0, 12);
  return hash;
}

interface CacheEntry {
  query: string;
  params: string;
  timestamp: number;
  tweets: Tweet[];
}

export function get(
  query: string,
  params: string = "",
  ttlMs: number = DEFAULT_TTL_MS
): Tweet[] | null {
  ensureDir();
  const key = cacheKey(query, params);
  const path = join(CACHE_DIR, `${key}.json`);

  if (!existsSync(path)) return null;

  try {
    const entry: CacheEntry = JSON.parse(readFileSync(path, "utf-8"));
    if (Date.now() - entry.timestamp > ttlMs) {
      unlinkSync(path);
      return null;
    }
    return entry.tweets;
  } catch {
    return null;
  }
}

export function set(
  query: string,
  params: string = "",
  tweets: Tweet[]
): void {
  ensureDir();
  const key = cacheKey(query, params);
  const path = join(CACHE_DIR, `${key}.json`);

  const entry: CacheEntry = {
    query,
    params,
    timestamp: Date.now(),
    tweets,
  };

  writeFileSync(path, JSON.stringify(entry, null, 2));
}

/**
 * Clear expired cache entries.
 */
export function prune(ttlMs: number = DEFAULT_TTL_MS): number {
  ensureDir();
  let removed = 0;
  const files = readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const path = join(CACHE_DIR, file);
    try {
      const stat = statSync(path);
      if (Date.now() - stat.mtimeMs > ttlMs) {
        unlinkSync(path);
        removed++;
      }
    } catch {}
  }

  return removed;
}

/**
 * Clear all cache.
 */
export function clear(): number {
  ensureDir();
  const files = readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    try {
      unlinkSync(join(CACHE_DIR, f));
    } catch {}
  }
  return files.length;
}
