/**
 * Unit tests for format.ts
 * Run with: bun test lib/format.test.ts
 */

import { describe, test, expect } from "bun:test";
import * as fmt from "./format";

const mockTweet = {
  id: "123",
  text: "This is a test tweet about AI and machine learning!",
  username: "testuser",
  name: "Test User",
  created_at: "2024-01-15T10:00:00.000Z",
  metrics: {
    likes: 150,
    retweets: 25,
    replies: 10,
    impressions: 5000
  },
  hashtags: ["AI", "ML"],
  mentions: [],
  urls: []
};

const mockTweet2 = {
  id: "456",
  text: "Another tweet with different metrics",
  username: "user2",
  name: "User Two",
  created_at: "2024-01-14T08:00:00.000Z",
  metrics: {
    likes: 10,
    retweets: 2,
    replies: 1,
    impressions: 100
  },
  hashtags: [],
  mentions: ["testuser"],
  urls: []
};

describe("Format Module", () => {
  describe("formatResultsTelegram", () => {
    test("formats single tweet correctly", () => {
      const result = fmt.formatResultsTelegram([mockTweet], { query: "test", limit: 10 });
      
      expect(result).toContain("testuser");
      expect(result).toContain("150");
    });

    test("respects limit parameter", () => {
      const tweets = Array(5).fill(mockTweet);
      const result = fmt.formatResultsTelegram(tweets, { query: "test", limit: 2 });
      
      // Should only show limited results
      expect(result.length).toBeGreaterThan(0);
    });

    test("handles empty array", () => {
      const result = fmt.formatResultsTelegram([], { query: "test", limit: 10 });
      
      expect(result).toContain("No results");
    });
  });

  describe("formatResultsJson", () => {
    test("returns valid JSON string", () => {
      const result = fmt.formatResultsJson([mockTweet]);
      
      expect(() => JSON.parse(result)).not.toThrow();
    });

    test("includes all tweets", () => {
      const tweets = [mockTweet, mockTweet2];
      const result = fmt.formatResultsJson(tweets);
      const parsed = JSON.parse(result);
      
      expect(parsed).toHaveLength(2);
    });
  });

  describe("formatResultsCsv", () => {
    test("returns CSV string", () => {
      const result = fmt.formatResultsCsv([mockTweet]);
      
      expect(result).toContain(",");
      expect(result).toContain("id");
    });

    test("includes header row", () => {
      const result = fmt.formatResultsCsv([mockTweet]);
      const lines = result.split("\n");
      
      expect(lines[0]).toContain("id");
      expect(lines[0]).toContain("text");
    });
  });

  describe("formatResearchMarkdown", () => {
    test("returns markdown string", () => {
      const result = fmt.formatResearchMarkdown("Test", [mockTweet], { queries: ["test"] });
      
      expect(result).toContain("#");
      expect(result).toContain("Test");
    });

    test("includes queries in header", () => {
      const result = fmt.formatResearchMarkdown("Test", [mockTweet], { queries: ["AI", "ML"] });
      
      expect(result).toContain("AI");
      expect(result).toContain("ML");
    });
  });

  describe("formatTweetMarkdown", () => {
    test("formats tweet as markdown", () => {
      const result = fmt.formatTweetMarkdown(mockTweet);
      
      expect(result).toContain("@testuser");
      expect(result).toContain("150");
    });

    test("includes metrics", () => {
      const result = fmt.formatTweetMarkdown(mockTweet);
      
      expect(result).toContain("likes");
    });

    test("includes hashtags", () => {
      const result = fmt.formatTweetMarkdown(mockTweet);
      
      expect(result).toContain("#AI");
      expect(result).toContain("#ML");
    });
  });
});

describe("Format Edge Cases", () => {
  test("handles tweet without metrics", () => {
    const tweetNoMetrics = {
      id: "789",
      text: "Simple tweet",
      username: "user",
      name: "User",
      created_at: "2024-01-01T00:00:00.000Z",
      metrics: undefined as any,
      hashtags: [],
      mentions: [],
      urls: []
    };
    
    const result = fmt.formatTweetMarkdown(tweetNoMetrics);
    expect(result).toContain("Simple tweet");
  });

  test("handles tweet without hashtags", () => {
    const tweetNoHashtags = {
      ...mockTweet,
      hashtags: []
    };
    
    const result = fmt.formatTweetMarkdown(tweetNoHashtags);
    expect(result).toContain("testuser");
  });

  test("handles tweet with long text", () => {
    const longTweet = {
      ...mockTweet,
      text: "A".repeat(500)
    };
    
    const result = fmt.formatTweetMarkdown(longTweet);
    expect(result.length).toBeGreaterThan(500);
  });

  test("handles tweet without username", () => {
    const tweetNoUser = {
      ...mockTweet,
      username: undefined as any,
      author_id: "author123"
    };
    
    const result = fmt.formatTweetMarkdown(tweetNoUser);
    expect(result).toContain("author123");
  });
});
