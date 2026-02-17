/**
 * Unit tests for moderation.ts
 * Run with: bun test lib/moderation.test.ts
 */

import { describe, expect, test } from "bun:test";
import { isLikelyUserId, parseListFlags } from "./moderation";

describe("moderation list flag parsing", () => {
  test("uses defaults when no flags are present", () => {
    const parsed = parseListFlags([]);
    expect(parsed.json).toBe(false);
    expect(parsed.limit).toBe(50);
  });

  test("parses --json and --limit", () => {
    const parsed = parseListFlags(["--json", "--limit", "25"]);
    expect(parsed.json).toBe(true);
    expect(parsed.limit).toBe(25);
  });

  test("clamps invalid limit to minimum 1", () => {
    const parsed = parseListFlags(["--limit", "0"]);
    expect(parsed.limit).toBe(1);
  });
});

describe("moderation user id detection", () => {
  test("detects numeric IDs", () => {
    expect(isLikelyUserId("2244994945")).toBe(true);
  });

  test("does not treat usernames as IDs", () => {
    expect(isLikelyUserId("jack")).toBe(false);
    expect(isLikelyUserId("@jack")).toBe(false);
  });
});

