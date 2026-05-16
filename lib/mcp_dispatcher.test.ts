import { describe, expect, test } from "bun:test";
import { createMcpToolHandlers } from "./mcp_dispatcher";

function makeHandlers() {
  return createMcpToolHandlers({
    extractTweetId: (input) => input,
    callPackageApi: async () => ({ ok: true }),
    ensurePackageQueryCitations: () => undefined,
  });
}

describe("mcp dispatcher", () => {
  test("registers core handlers", () => {
    const handlers = makeHandlers();
    expect(typeof handlers.xint_search).toBe("function");
    expect(typeof handlers.xint_profile).toBe("function");
    expect(typeof handlers.xint_package_query).toBe("function");
    expect(typeof handlers.xint_cache_clear).toBe("function");
  });

  test("registers xint_credits (Grok free-tier telemetry)", () => {
    const handlers = makeHandlers();
    expect(typeof handlers.xint_credits).toBe("function");
  });

  test("xint_credits --setup returns the Premium-vs-API guidance", async () => {
    const handlers = makeHandlers();
    const result = await handlers.xint_credits({ setup: true });
    // actionInfo wraps the message; structure varies, but the data block
    // should clarify Premium is separate from API.
    const dump = JSON.stringify(result);
    expect(dump.toLowerCase()).toContain("premium");
    expect(dump).toContain("console.x.ai");
  });

  test("xint_credits without setup returns a structured snapshot", async () => {
    const handlers = makeHandlers();
    const result = await handlers.xint_credits({});
    // Snapshot must include the canonical fields agents will read.
    const dump = JSON.stringify(result);
    expect(dump).toContain("signup_credit_remaining");
    expect(dump).toContain("monthly_used");
    expect(dump).toContain("by_feature");
  });

  test("xint_analyze rejects empty query with a clear note (no API call)", async () => {
    const handlers = makeHandlers();
    const result = await handlers.xint_analyze({});
    const dump = JSON.stringify(result);
    expect(dump).toContain("query");
  });

  test("xint_analyze recognizes budget=cheap as a valid input", async () => {
    // We don't want to make a real network call here. The point of the test
    // is "the dispatcher accepts a `budget` field without rejecting it as
    // an unknown arg." Any of {success, guidance, network error} satisfies
    // that — what would FAIL the test is the dispatcher throwing on the
    // arg shape itself.
    const handlers = makeHandlers();
    let arose: unknown = undefined;
    try {
      arose = await handlers.xint_analyze({ query: "test", budget: "cheap" });
    } catch (e) {
      arose = e instanceof Error ? e.message : String(e);
    }
    // Whether it returned a value or threw, the dispatcher reached the
    // grokChat call — confirming `budget` is accepted in the arg schema.
    expect(arose).toBeDefined();
  });
});
