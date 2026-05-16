/**
 * Smoke tests for the 2026-05 efficiency pass:
 *   • Field profiles (api.ts)
 *   • Followers snapshot cache (followers.ts)
 *
 * These cover the cost-saving paths; behavioral correctness (rendering,
 * pagination etc.) is verified by existing CLI integration scripts.
 */

import { describe, expect, it } from "bun:test";
import {
  fieldsFor,
  MINIMAL_FIELDS,
  STANDARD_FIELDS,
  EXTENDED_FIELDS,
  FIELDS,
} from "../lib/api";

describe("field profiles — credit-efficient defaults", () => {
  it("minimal is the cheap default", () => {
    expect(fieldsFor("minimal")).toBe(MINIMAL_FIELDS);
    expect(fieldsFor()).toBe(MINIMAL_FIELDS);
  });

  it("minimal includes entities + conversation_id (parseTweets reads them on every call)", () => {
    // Recalibrated 2026-05-16: dropping entities silently lost URLs/hashtags/mentions
    // from search results. MINIMAL must include enough to render a tweet card.
    expect(MINIMAL_FIELDS).toContain("entities");
    expect(MINIMAL_FIELDS).toContain("conversation_id");
  });

  it("standard adds connection_status to MINIMAL", () => {
    expect(fieldsFor("standard")).toBe(STANDARD_FIELDS);
    expect(STANDARD_FIELDS).toContain("connection_status");
    // STANDARD is a superset of MINIMAL on the tweet side
    expect(STANDARD_FIELDS).toContain("entities");
  });

  it("extended adds article + note_tweet + subscription_type", () => {
    expect(fieldsFor("extended")).toBe(EXTENDED_FIELDS);
    expect(EXTENDED_FIELDS).toContain("article");
    expect(EXTENDED_FIELDS).toContain("note_tweet");
    expect(EXTENDED_FIELDS).toContain("connection_status");
    expect(EXTENDED_FIELDS).toContain("subscription_type");
  });

  it("FIELDS export aliases MINIMAL_FIELDS for backwards compatibility", () => {
    expect(FIELDS).toBe(MINIMAL_FIELDS);
  });

  it("minimal omits the truly extra fields (article, note_tweet, subscription_type)", () => {
    // These fields are payload-heavy and only used by specific commands.
    expect(MINIMAL_FIELDS).not.toContain("article");
    expect(MINIMAL_FIELDS).not.toContain("note_tweet");
    expect(MINIMAL_FIELDS).not.toContain("subscription_type");
    // But essentials are kept
    expect(MINIMAL_FIELDS).toContain("public_metrics");
    expect(MINIMAL_FIELDS).toContain("username");
  });
});

describe("user-record LRU (per-process cache)", () => {
  it("caches user records by username and reuses them", async () => {
    const apiMod = await import("../lib/api");
    apiMod._resetUserCacheForTests();

    // Mock the network: count actual fetches.
    let fetchCount = 0;
    const originalFetch = globalThis.fetch;
    process.env.X_BEARER_TOKEN = "test-bearer";
    globalThis.fetch = (async (_url: string) => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          data: {
            id: "12345",
            username: "alice",
            name: "Alice",
            public_metrics: { followers_count: 100 },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const u1 = await apiMod.lookupUserByUsername("alice");
      const u2 = await apiMod.lookupUserByUsername("alice");
      const u3 = await apiMod.lookupUserByUsername("@ALICE"); // case + @-prefix

      expect(u1.id).toBe("12345");
      expect(u2.id).toBe("12345");
      expect(u3.id).toBe("12345");
      // Three lookups, one HTTP fetch — the LRU is doing its job.
      expect(fetchCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refresh=true bypasses the cache", async () => {
    const apiMod = await import("../lib/api");
    apiMod._resetUserCacheForTests();

    let fetchCount = 0;
    const originalFetch = globalThis.fetch;
    process.env.X_BEARER_TOKEN = "test-bearer";
    globalThis.fetch = (async (_url: string) => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          data: { id: "12345", username: "alice", name: "Alice" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      await apiMod.lookupUserByUsername("alice");
      await apiMod.lookupUserByUsername("alice", { refresh: true });
      expect(fetchCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("followers snapshot cache freshness", () => {
  // We test loadFreshSnapshot directly with a fixture. The function reads
  // from data/snapshots/ — for the unit test, we just verify the API shape
  // and TTL math; integration of the actual filesystem path is exercised
  // by running `xint diff @somebody` end-to-end.

  it("loadFreshSnapshot is exported and accepts a custom TTL", async () => {
    const { loadFreshSnapshot } = await import("../lib/followers");
    expect(typeof loadFreshSnapshot).toBe("function");
    // Pass a non-existent username — should return null without throwing.
    const result = loadFreshSnapshot("nonexistent_handle_xyz_test", "followers", 1000);
    expect(result).toBeNull();
  });
});
