import { beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import {
  consumeCommandFallback,
  getReliabilityReport,
  markCommandFallback,
  recordCommandResult,
} from "./reliability";

const TEST_FILE = "/tmp/xint-test-reliability.json";

describe("reliability metrics", () => {
  beforeEach(() => {
    process.env.XINT_RELIABILITY_DATA_FILE = TEST_FILE;
    try {
      rmSync(TEST_FILE, { force: true });
    } catch {
      // ignore
    }
  });

  test("records command success and computes rates", () => {
    recordCommandResult("search", true, 120, { mode: "cli" });
    recordCommandResult("search", false, 340, { mode: "cli" });
    recordCommandResult("search", true, 200, { mode: "mcp" });

    const report = getReliabilityReport(7);
    const search = report.by_command.search;

    expect(report.total_calls).toBe(3);
    expect(search.calls).toBe(3);
    expect(search.success_rate).toBeCloseTo(0.6667, 4);
    expect(search.error_rate).toBeCloseTo(0.3333, 4);
    expect(search.p95_latency_ms).toBe(340);
  });

  test("tracks fallback marks", () => {
    markCommandFallback("trends");

    expect(consumeCommandFallback("trends")).toBe(true);
    expect(consumeCommandFallback("trends")).toBe(false);
  });

  test("includes fallback rates", () => {
    recordCommandResult("trends", true, 40, { fallback: true });
    recordCommandResult("trends", true, 35, { fallback: false });

    const report = getReliabilityReport(7);

    expect(report.by_command.trends.fallback_rate).toBe(0.5);
  });
});
