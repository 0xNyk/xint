import { describe, expect, test } from "bun:test";
import { createMcpToolHandlers } from "./mcp_dispatcher";

describe("mcp dispatcher", () => {
  test("registers core handlers", () => {
    const handlers = createMcpToolHandlers({
      extractTweetId: (input) => input,
      callPackageApi: async () => ({ ok: true }),
      ensurePackageQueryCitations: () => undefined,
    });

    expect(typeof handlers.xint_search).toBe("function");
    expect(typeof handlers.xint_profile).toBe("function");
    expect(typeof handlers.xint_package_query).toBe("function");
    expect(typeof handlers.xint_cache_clear).toBe("function");
  });
});
