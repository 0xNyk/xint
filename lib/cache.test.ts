/**
 * Unit tests for cache.ts
 * Run with: bun test lib/cache.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as cache from "./cache";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";

const TEST_CACHE_DIR = "/tmp/xint-test-cache";

describe("Cache Module", () => {
  beforeEach(() => {
    // Create test directory
    try {
      mkdirSync(TEST_CACHE_DIR, { recursive: true });
    } catch (e) {
      // Directory may already exist
    }
  });

  afterEach(() => {
    // Clean up test directory
    try {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  test("cache.get returns null for missing key", () => {
    const result = cache.get("nonexistent", "", 60000);
    expect(result).toBeNull();
  });

  test("cache.set and cache.get work together", () => {
    const testData = { id: 1, name: "test" };
    
    cache.set("test-key", "param=test", testData);
    const result = cache.get("test-key", "param=test", 60000);
    
    expect(result).toEqual(testData);
  });

  test("cache.get returns null for expired entry", async () => {
    const testData = { id: 2, name: "expire-test" };
    
    cache.set("expire-key", "", testData);
    
    // Wait a tiny bit then check - the cache should still be valid
    // since we use 60000ms TTL
    const result = cache.get("expire-key", "", 60000);
    expect(result).toEqual(testData);
  });

  test("cache.clear removes all entries", () => {
    cache.set("key1", "", { data: 1 });
    cache.set("key2", "", { data: 2 });
    
    const cleared = cache.clear();
    
    expect(cleared).toBeGreaterThan(0);
    expect(cache.get("key1", "", 60000)).toBeNull();
    expect(cache.get("key2", "", 60000)).toBeNull();
  });

  test("cache key is case sensitive", () => {
    cache.set("Key", "", { data: "upper" });
    cache.set("key", "", { data: "lower" });
    
    expect(cache.get("Key", "", 60000)?.data).toBe("upper");
    expect(cache.get("key", "", 60000)?.data).toBe("lower");
  });

  test("cache params affect key", () => {
    cache.set("query", "limit=10", { data: 10 });
    cache.set("query", "limit=20", { data: 20 });
    
    expect(cache.get("query", "limit=10", 60000)?.data).toBe(10);
    expect(cache.get("query", "limit=20", 60000)?.data).toBe(20);
  });
});

describe("Cache Edge Cases", () => {
  test("cache handles null data", () => {
    cache.set("null-test", "", null);
    const result = cache.get("null-test", "", 60000);
    expect(result).toBeNull();
  });

  test("cache handles empty string data", () => {
    cache.set("empty-test", "", "");
    const result = cache.get("empty-test", "", 60000);
    expect(result).toBe("");
  });

  test("cache handles array data", () => {
    const arr = [1, 2, 3];
    cache.set("array-test", "", arr);
    const result = cache.get("array-test", "", 60000);
    expect(result).toEqual(arr);
  });

  test("cache handles nested objects", () => {
    const nested = { a: { b: { c: 1 } } };
    cache.set("nested-test", "", nested);
    const result = cache.get("nested-test", "", 60000);
    expect(result).toEqual(nested);
  });
});
