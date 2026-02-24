import { describe, expect, test } from "bun:test";
import { pickArticleUrlFromTweet, resolveArticleTimeoutMs, reconstructArticleContent } from "./article";

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

describe("reconstructArticleContent", () => {
  test("returns plain_text when no code blocks", () => {
    const result = reconstructArticleContent({
      title: "Test",
      plain_text: "Hello world article content.",
    });
    expect(result).toBe("Hello world article content.");
  });

  test("appends code blocks when present", () => {
    const result = reconstructArticleContent({
      title: "Test",
      plain_text: "Some article text.",
      entities: {
        code: [
          { language: "typescript", code: "const x = 1;", content: "```typescript\nconst x = 1;\n```" },
        ],
      },
    });
    expect(result).toContain("Some article text.");
    expect(result).toContain("Code examples from article:");
    expect(result).toContain("```typescript");
    expect(result).toContain("const x = 1;");
  });
});

describe("article timeout config", () => {
  test("uses default timeout when unset", () => {
    const prev = process.env.XINT_ARTICLE_TIMEOUT_SEC;
    delete process.env.XINT_ARTICLE_TIMEOUT_SEC;
    expect(resolveArticleTimeoutMs()).toBe(30000);
    process.env.XINT_ARTICLE_TIMEOUT_SEC = prev;
  });

  test("clamps timeout range to safe bounds", () => {
    const prev = process.env.XINT_ARTICLE_TIMEOUT_SEC;
    process.env.XINT_ARTICLE_TIMEOUT_SEC = "1";
    expect(resolveArticleTimeoutMs()).toBe(5000);
    process.env.XINT_ARTICLE_TIMEOUT_SEC = "999";
    expect(resolveArticleTimeoutMs()).toBe(120000);
    process.env.XINT_ARTICLE_TIMEOUT_SEC = prev;
  });
});
