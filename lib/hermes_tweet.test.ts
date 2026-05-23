import { afterEach, describe, expect, test } from "bun:test";
import { search as apiSearch } from "./api";
import {
  buildHeaders,
  buildUrl,
  extractItems,
  normalizeReadBackend,
  normalizeTweet,
  readBackendEnabled,
} from "./hermes_tweet";

const ORIGINAL_FETCH = globalThis.fetch;
type FetchStub = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

function clearEnv(): void {
  delete process.env.XINT_READ_BACKEND;
  delete process.env.XINT_BACKEND;
  delete process.env.TWITTER_BACKEND;
  delete process.env.XQUIK_API_KEY;
  delete process.env.HERMES_TWEET_API_KEY;
  delete process.env.XQUIK_BASE_URL;
}

function replaceFetch(nextFetch: FetchStub | typeof fetch): void {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = nextFetch as typeof fetch;
}

afterEach(() => {
  clearEnv();
  replaceFetch(ORIGINAL_FETCH);
});

describe("Hermes Tweet backend adapter", () => {
  test("normalizes backend aliases", () => {
    expect(normalizeReadBackend("hermes_tweet")).toBe("hermes-tweet");
    expect(normalizeReadBackend(" XQUIK ")).toBe("xquik");
  });

  test("enables only explicit Hermes Tweet aliases", () => {
    process.env.XINT_READ_BACKEND = "hermes-tweet";
    expect(readBackendEnabled()).toBe(true);

    process.env.XINT_READ_BACKEND = "x-api";
    expect(readBackendEnabled()).toBe(false);
  });

  test("uses x-api-key for Xquik-style keys and bearer otherwise", () => {
    expect(buildHeaders("xq_test")).toMatchObject({ "x-api-key": "xq_test" });
    expect(buildHeaders("plain-token")).toMatchObject({
      Authorization: "Bearer plain-token",
    });
  });

  test("builds encoded API URLs", () => {
    process.env.XQUIK_BASE_URL = "https://example.test/";

    const url = buildUrl("/api/v1/x/tweets/search", {
      query: "AI agents",
      limit: 3,
    });

    expect(url).toBe("https://example.test/api/v1/x/tweets/search?query=AI+agents&limit=3");
  });

  test("extracts nested result arrays", () => {
    const payload = {
      data: {
        tweets: [{ id: "1" }],
      },
    };

    expect(extractItems(payload)).toEqual([{ id: "1" }]);
  });

  test("normalizes tweet envelopes into xint tweets", () => {
    const tweet = normalizeTweet({
      tweet: {
        id: "123",
        text: "hello https://example.com",
        created_at: "2026-05-23T00:00:00.000Z",
        public_metrics: {
          like_count: 7,
          retweet_count: 2,
          reply_count: 1,
          quote_count: 3,
          impression_count: 100,
          bookmark_count: 4,
        },
        entities: {
          urls: [{ expanded_url: "https://example.com", title: "Example" }],
          mentions: [{ username: "alice" }],
          hashtags: [{ tag: "AI" }],
        },
      },
      author: {
        id: "42",
        username: "builder",
        name: "Builder",
      },
    });

    expect(tweet).toMatchObject({
      id: "123",
      username: "builder",
      name: "Builder",
      metrics: {
        likes: 7,
        retweets: 2,
        replies: 1,
        quotes: 3,
        impressions: 100,
        bookmarks: 4,
      },
      mentions: ["alice"],
      hashtags: ["AI"],
    });
    expect(tweet?.urls[0]).toMatchObject({
      url: "https://example.com",
      title: "Example",
    });
  });

  test("routes api.search through Hermes Tweet when configured", async () => {
    process.env.XINT_READ_BACKEND = "hermes-tweet";
    process.env.XQUIK_API_KEY = "xq_test";
    process.env.XQUIK_BASE_URL = "https://example.test";

    let requestedUrl = "";
    let requestedKey = "";
    replaceFetch(async (input: URL | RequestInfo, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedKey = String((init?.headers as Record<string, string>)["x-api-key"]);
      return new Response(
        JSON.stringify({
          data: {
            tweets: [
              {
                id: "9",
                text: "agent launch",
                username: "xint",
                metrics: { likes: 5 },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const tweets = await apiSearch("agent launch", { maxResults: 2 });

    expect(requestedUrl).toContain("/api/v1/x/tweets/search");
    expect(requestedUrl).toContain("query=agent+launch");
    expect(requestedKey).toBe("xq_test");
    expect(tweets).toHaveLength(1);
    expect(tweets[0]?.id).toBe("9");
  });
});
