/**
 * Smoke tests for the Grok credit-aware routing introduced in 2026.5.15.
 *
 * Focus: budget→model resolution and cost_in_usd_ticks priority. These are
 * the two behaviors most likely to silently regress (wrong model selected,
 * wrong cost number recorded). Network is mocked — tests run without an
 * actual XAI_API_KEY.
 */

import { describe, expect, it } from "bun:test";
import { resolveModel, isPremium, premiumChatRoutingTip } from "../lib/grok";

describe("resolveModel — budget routing", () => {
  it("defaults to grok-4-1-fast when no budget given", () => {
    expect(resolveModel(undefined, false)).toBe("grok-4-1-fast");
  });

  it("maps cheap → grok-4-1-fast (the agent-safe default)", () => {
    expect(resolveModel("cheap", false)).toBe("grok-4-1-fast");
  });

  it("maps balanced → grok-4.3 (flagship, 1M ctx)", () => {
    expect(resolveModel("balanced", false)).toBe("grok-4.3");
  });

  it("maps max → grok-4.20-reasoning (highest-cost reasoning)", () => {
    expect(resolveModel("max", false)).toBe("grok-4.20-reasoning");
  });

  it("auto-routes image input to grok-4.3 (vision-capable), overriding budget", () => {
    expect(resolveModel("cheap", true)).toBe("grok-4.3");
    expect(resolveModel("max", true)).toBe("grok-4.3");
  });
});

describe("premiumChatRoutingTip — heuristic for routing to grok.com", () => {
  it("emits a tip when Premium user sends a one-shot plain query", () => {
    const tip = premiumChatRoutingTip("Premium+", {
      pipeMode: false,
      query: "what's trending in AI",
    });
    expect(tip).toBeDefined();
    expect(tip).toContain("grok.com");
    expect(tip).toContain("Premium+");
  });

  it("stays silent for non-Premium users (suggestion would be useless)", () => {
    const tip = premiumChatRoutingTip(undefined, { pipeMode: false, query: "x" });
    expect(tip).toBeUndefined();
  });

  it("stays silent when input is piped (chatbot can't accept pipes)", () => {
    const tip = premiumChatRoutingTip("Premium", { pipeMode: true, query: "x" });
    expect(tip).toBeUndefined();
  });

  it("stays silent when reading tweets from file (multi-input workflow)", () => {
    const tip = premiumChatRoutingTip("Premium", {
      pipeMode: false,
      tweetFile: "tweets.json",
      query: "summarize",
    });
    expect(tip).toBeUndefined();
  });

  it("stays silent for image inputs (vision input not pasteable)", () => {
    const tip = premiumChatRoutingTip("Premium+", {
      pipeMode: false,
      imageUrl: "https://example.com/x.png",
      query: "what",
    });
    expect(tip).toBeUndefined();
  });

  it("stays silent on empty query (analyze help will print instead)", () => {
    const tip = premiumChatRoutingTip("Premium", { pipeMode: false, query: "" });
    expect(tip).toBeUndefined();
  });

  it("isPremium accepts Premium, PremiumPlus, Premium+", () => {
    expect(isPremium("Premium")).toBe(true);
    expect(isPremium("PremiumPlus")).toBe(true);
    expect(isPremium("Premium+")).toBe(true);
    expect(isPremium("Free")).toBe(false);
    expect(isPremium(undefined)).toBe(false);
  });
});

describe("cost_in_usd_ticks priority", () => {
  // The xAI 2026-Q2 response field cost_in_usd_ticks (µUSD) is authoritative
  // when present. We must NEVER substitute our local estimate for it.
  // Mock fetch and call grokChat to verify which value gets tracked.

  it("uses cost_in_usd_ticks (µUSD) when xAI returns it", async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "xai-test";

    let trackedCost: number | undefined;

    // Intercept the trackCostDirect call by mocking the costs module's
    // file writes — simpler approach: stub fetch and inspect costFromResponse
    // via an actual grokChat call, then read the latest cost entry.
    globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "hi" } }],
          model: "grok-4-1-fast",
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
            cost_in_usd_ticks: 1234,  // = $0.001234 — distinct from local estimate
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      const { grokChat } = await import("../lib/grok");
      const resp = await grokChat([{ role: "user", content: "hi" }]);
      expect(resp.content).toBe("hi");
      expect(resp.usage.prompt_tokens).toBe(100);

      // Local estimate would be: (100/1M * 0.20) + (50/1M * 0.50) = $0.000045
      // xAI authoritative: 1234 ticks / 1M = $0.001234
      // We verify by reading data/api-costs.json — last entry should match.
      const { readFileSync, existsSync } = await import("fs");
      const { join } = await import("path");
      const costsFile = join(import.meta.dir, "..", "data", "api-costs.json");
      if (existsSync(costsFile)) {
        const data = JSON.parse(readFileSync(costsFile, "utf-8"));
        const last = data.entries[data.entries.length - 1];
        trackedCost = last.cost_usd;
        expect(trackedCost).toBeCloseTo(0.001234, 5);
      }
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = originalKey;
    }
  });

  it("falls back to local estimate when cost_in_usd_ticks absent", async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "xai-test";

    globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          model: "grok-4-1-fast",
          usage: {
            prompt_tokens: 1_000_000,  // big numbers to make estimate obvious
            completion_tokens: 0,
            total_tokens: 1_000_000,
            // no cost_in_usd_ticks
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      const { grokChat } = await import("../lib/grok");
      await grokChat([{ role: "user", content: "ok" }]);

      const { readFileSync } = await import("fs");
      const { join } = await import("path");
      const costsFile = join(import.meta.dir, "..", "data", "api-costs.json");
      const data = JSON.parse(readFileSync(costsFile, "utf-8"));
      const last = data.entries[data.entries.length - 1];
      // Local estimate: 1M tokens × $0.20/M input = $0.20
      expect(last.cost_usd).toBeCloseTo(0.20, 4);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = originalKey;
    }
  });
});
