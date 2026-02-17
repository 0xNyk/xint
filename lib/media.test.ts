import { describe, expect, test } from "bun:test";
import {
  extractTweetId,
  inferExtension,
  matchesMediaFilter,
  parseMaxItems,
  renderFileNameTemplate,
  selectDownloadUrl,
} from "./media";

describe("media helpers", () => {
  test("extractTweetId handles numeric id and URL formats", () => {
    expect(extractTweetId("1900100012345678901")).toBe("1900100012345678901");
    expect(extractTweetId("https://x.com/user/status/1900100012345678901")).toBe("1900100012345678901");
    expect(extractTweetId("https://twitter.com/i/web/status/1900100012345678901")).toBe(
      "1900100012345678901",
    );
  });

  test("selectDownloadUrl chooses best MP4 variant for videos", () => {
    const url = selectDownloadUrl({
      media_key: "3_1",
      type: "video",
      variants: [
        { content_type: "video/mp4", bit_rate: 256000, url: "https://video/low.mp4" },
        { content_type: "video/mp4", bit_rate: 832000, url: "https://video/high.mp4" },
      ],
    });
    expect(url).toBe("https://video/high.mp4");
  });

  test("inferExtension falls back to type defaults", () => {
    expect(inferExtension("https://pbs.twimg.com/media/abc", "photo")).toBe("jpg");
    expect(inferExtension("https://video.twimg.com/ext_tw_video/1", "video")).toBe("mp4");
  });

  test("parseMaxItems validates positive integer", () => {
    expect(parseMaxItems("3")).toBe(3);
    expect(parseMaxItems("0")).toBeNull();
    expect(parseMaxItems("-1")).toBeNull();
    expect(parseMaxItems("abc")).toBeNull();
  });

  test("matchesMediaFilter handles photos and video/gif", () => {
    const photo = { media_key: "3_1", type: "photo" as const };
    const video = { media_key: "3_2", type: "video" as const };
    const gif = { media_key: "3_3", type: "animated_gif" as const };

    expect(matchesMediaFilter(photo, "photos")).toBe(true);
    expect(matchesMediaFilter(video, "photos")).toBe(false);
    expect(matchesMediaFilter(gif, "video")).toBe(true);
    expect(matchesMediaFilter(video, "video")).toBe(true);
    expect(matchesMediaFilter(photo, "video")).toBe(false);
  });

  test("renderFileNameTemplate supports placeholders and appends extension", () => {
    const name = renderFileNameTemplate("{username}-{created_at}-{index}", {
      tweetId: "1900100012345678901",
      username: "alice",
      index: 2,
      mediaType: "photo",
      mediaKey: "3_1",
      createdAt: "2026-02-17T10:22:30.000Z",
      ext: "jpg",
    });
    expect(name).toBe("alice-2026-02-17T10_22_30_000Z-2.jpg");
  });

  test("renderFileNameTemplate preserves explicit extension placeholder", () => {
    const name = renderFileNameTemplate("{tweet_id}-{index}.{ext}", {
      tweetId: "1900100012345678901",
      username: "alice",
      index: 1,
      mediaType: "video",
      mediaKey: "3_2",
      createdAt: undefined,
      ext: "mp4",
    });
    expect(name).toBe("1900100012345678901-1.mp4");
  });
});
