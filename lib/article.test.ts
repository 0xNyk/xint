import { describe, expect, test } from "bun:test";
import { pickArticleUrlFromTweet } from "./article";

describe("article url extraction", () => {
  test("prefers external URL from parsed tweet urls", () => {
    const tweet = {
      urls: [
        { url: "https://x.com/i/article/abc123" },
        { url: "https://example.com/deep-dive" },
      ],
    };
    expect(pickArticleUrlFromTweet(tweet)).toBe("https://example.com/deep-dive");
  });

  test("falls back to x article URL when only x article is present", () => {
    const tweet = {
      urls: [{ url: "https://x.com/i/article/xyz789" }],
    };
    expect(pickArticleUrlFromTweet(tweet)).toBe("https://x.com/i/article/xyz789");
  });

  test("supports raw entities url payload shape", () => {
    const tweet = {
      entities: {
        urls: [
          { expanded_url: "https://x.com/i/article/one" },
          { unwound_url: "https://news.ycombinator.com/item?id=1" },
        ],
      },
    };
    expect(pickArticleUrlFromTweet(tweet)).toBe("https://news.ycombinator.com/item?id=1");
  });
});
