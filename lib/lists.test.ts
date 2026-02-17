/**
 * Unit tests for lists.ts
 * Run with: bun test lib/lists.test.ts
 */

import { describe, expect, test } from "bun:test";
import { isLikelyUserId, parseCommonFlags } from "./lists";

describe("lists flag parsing", () => {
  test("uses defaults when no flags are provided", () => {
    const parsed = parseCommonFlags([]);
    expect(parsed.json).toBe(false);
    expect(parsed.limit).toBe(50);
  });

  test("parses json and limit flags", () => {
    const parsed = parseCommonFlags(["--json", "--limit", "15"]);
    expect(parsed.json).toBe(true);
    expect(parsed.limit).toBe(15);
  });

  test("clamps limit to at least 1", () => {
    const parsed = parseCommonFlags(["--limit", "0"]);
    expect(parsed.limit).toBe(1);
  });
});

describe("list member user identifier detection", () => {
  test("accepts numeric IDs", () => {
    expect(isLikelyUserId("2244994945")).toBe(true);
  });

  test("rejects usernames", () => {
    expect(isLikelyUserId("jack")).toBe(false);
    expect(isLikelyUserId("@jack")).toBe(false);
  });
});

