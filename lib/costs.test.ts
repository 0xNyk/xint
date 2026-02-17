/**
 * Unit tests for costs.ts
 * Run with: bun test lib/costs.test.ts
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { trackCost, checkBudget, getTodayCosts, setBudget, getCostSummary } from "./costs";

// Test file path - use temp for tests
const TEST_DATA_FILE = "/tmp/xint-test-costs.json";

describe("Cost Tracking", () => {
  beforeEach(() => {
    // Reset for each test
  });

  test("trackCost calculates correct cost for search", () => {
    const entry = trackCost("search", "/2/tweets/search/recent", 10);
    
    expect(entry.operation).toBe("search");
    expect(entry.endpoint).toBe("/2/tweets/search/recent");
    expect(entry.tweets_read).toBe(10);
    expect(entry.cost_usd).toBe(0.05); // 0.005 * 10
  });

  test("trackCost calculates correct cost for profile", () => {
    const entry = trackCost("profile", "/2/users/by/username/test", 5);
    
    expect(entry.cost_usd).toBe(0.025); // 0.005 * 5
  });

  test("trackCost calculates correct cost for like action", () => {
    const entry = trackCost("like", "/2/users/me/likes", 0);
    
    expect(entry.cost_usd).toBe(0.01); // per_call rate
  });

  test("trackCost calculates correct cost for trends", () => {
    const entry = trackCost("trends", "/2/trends/by/woeid/1", 0);
    
    expect(entry.cost_usd).toBe(0.10); // per_call rate
  });

  test("trackCost uses fallback rate for unknown operation", () => {
    const entry = trackCost("unknown_op", "/unknown", 20);
    
    // Should use default 0.005 per tweet
    expect(entry.cost_usd).toBe(0.1); // 0.005 * 20
  });

  test("checkBudget returns correct status", () => {
    const status = checkBudget();
    
    expect(status).toHaveProperty("allowed");
    expect(status).toHaveProperty("spent");
    expect(status).toHaveProperty("limit");
    expect(status).toHaveProperty("remaining");
    expect(status).toHaveProperty("warning");
  });

  test("getTodayCosts returns today aggregate", () => {
    const today = getTodayCosts();
    
    expect(today).toHaveProperty("date");
    expect(today).toHaveProperty("total_cost");
    expect(today).toHaveProperty("calls");
    expect(today).toHaveProperty("tweets_read");
    expect(today).toHaveProperty("by_operation");
  });

  test("setBudget updates daily limit", () => {
    const originalLimit = checkBudget().limit;
    
    setBudget(5.0);
    const status = checkBudget();
    
    expect(status.limit).toBe(5.0);
    
    // Restore original
    setBudget(originalLimit);
  });

  test("getCostSummary returns string for today", () => {
    const summary = getCostSummary("today");
    
    expect(typeof summary).toBe("string");
    expect(summary.length).toBeGreaterThan(0);
  });

  test("getCostSummary returns string for week", () => {
    const summary = getCostSummary("week");
    
    expect(typeof summary).toBe("string");
  });

  test("getCostSummary returns string for month", () => {
    const summary = getCostSummary("month");
    
    expect(typeof summary).toBe("string");
  });

  test("getCostSummary returns string for all", () => {
    const summary = getCostSummary("all");
    
    expect(typeof summary).toBe("string");
  });
});

describe("Cost Rates", () => {
  test("COST_RATES has search rate", () => {
    const { COST_RATES } = require("./costs");
    
    expect(COST_RATES.search.per_tweet).toBe(0.005);
    expect(COST_RATES.search.per_call).toBe(0);
  });

  test("COST_RATES has like rate", () => {
    const { COST_RATES } = require("./costs");
    
    expect(COST_RATES.like.per_call).toBe(0.01);
  });

  test("COST_RATES has follow/unfollow rates", () => {
    const { COST_RATES } = require("./costs");

    expect(COST_RATES.follow.per_call).toBe(0.01);
    expect(COST_RATES.unfollow.per_call).toBe(0.01);
  });

  test("COST_RATES has stream rates", () => {
    const { COST_RATES } = require("./costs");

    expect(COST_RATES.media_metadata.per_tweet).toBe(0.005);
    expect(COST_RATES.stream_connect.per_tweet).toBe(0.005);
    expect(COST_RATES.stream_rules_list.per_call).toBe(0.01);
    expect(COST_RATES.stream_rules_add.per_call).toBe(0.01);
    expect(COST_RATES.stream_rules_delete.per_call).toBe(0.01);
  });

  test("COST_RATES has trends rate", () => {
    const { COST_RATES } = require("./costs");
    
    expect(COST_RATES.trends.per_call).toBe(0.10);
  });

  test("COST_RATES has bookmarks rate", () => {
    const { COST_RATES } = require("./costs");
    
    expect(COST_RATES.bookmarks.per_tweet).toBe(0.005);
  });
});
