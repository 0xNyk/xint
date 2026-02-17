/**
 * media.ts — Download media from a tweet using official X API endpoints.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { BASE, bearerGet } from "./api";
import { trackCost } from "./costs";

interface RawMediaVariant {
  bit_rate?: number;
  content_type?: string;
  url?: string;
}

interface RawMedia {
  media_key: string;
  type: "photo" | "video" | "animated_gif" | string;
  url?: string;
  preview_image_url?: string;
  variants?: RawMediaVariant[];
}

interface DownloadRecord {
  mediaKey: string;
  type: string;
  sourceUrl?: string;
  savedPath?: string;
  bytes?: number;
  error?: string;
}

type MediaFilter = "all" | "photos" | "video";
interface FileNameContext {
  tweetId: string;
  username?: string;
  index: number; // 1-based
  mediaType: string;
  mediaKey: string;
  createdAt?: string;
  ext: string;
}

const DOWNLOAD_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const DEFAULT_NAME_TEMPLATE = "{tweet_id}-{index}-{type}";

export function extractTweetId(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;

  const match = trimmed.match(
    /(?:x|twitter)\.com\/(?:(?:[^/\s]+\/status)|(?:i\/web\/status)|(?:i\/status))\/(\d+)/i,
  );
  if (match) return match[1];

  const fallback = trimmed.match(/status\/(\d+)/i);
  return fallback ? fallback[1] : null;
}

export function inferExtension(mediaUrl: string, mediaType: string): string {
  try {
    const parsed = new URL(mediaUrl);
    const pathname = parsed.pathname.toLowerCase();
    const dot = pathname.lastIndexOf(".");
    if (dot > 0) {
      const ext = pathname.slice(dot + 1);
      if (/^[a-z0-9]{2,5}$/.test(ext)) return ext;
    }

    const format = parsed.searchParams.get("format");
    if (format && /^[a-z0-9]{2,5}$/i.test(format)) return format.toLowerCase();
  } catch {
    // Fall through to type-based defaults.
  }

  if (mediaType === "video" || mediaType === "animated_gif") return "mp4";
  return "jpg";
}

export function parseMaxItems(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function isVideoLike(type: string): boolean {
  return type === "video" || type === "animated_gif";
}

export function matchesMediaFilter(media: RawMedia, filter: MediaFilter): boolean {
  if (filter === "all") return true;
  if (filter === "photos") return media.type === "photo";
  return isVideoLike(media.type);
}

export function selectDownloadUrl(media: RawMedia): string | null {
  if (media.type === "photo") {
    return media.url || media.preview_image_url || null;
  }

  const variants = (media.variants || [])
    .filter((v) => v.url && (v.content_type || "").toLowerCase().includes("mp4"))
    .sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));

  if (variants.length > 0) return variants[0].url || null;
  return media.preview_image_url || media.url || null;
}

function sanitizeNamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

function sanitizeFileName(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function renderFileNameTemplate(
  template: string | undefined,
  ctx: FileNameContext,
): string {
  const rawTemplate = template?.trim() || DEFAULT_NAME_TEMPLATE;
  const replacements: Record<string, string> = {
    "{tweet_id}": sanitizeNamePart(ctx.tweetId),
    "{username}": sanitizeNamePart(ctx.username || "unknown"),
    "{index}": String(ctx.index),
    "{type}": sanitizeNamePart(ctx.mediaType || "media"),
    "{media_key}": sanitizeNamePart(ctx.mediaKey || "unknown"),
    "{created_at}": sanitizeNamePart(ctx.createdAt || "unknown"),
    "{ext}": sanitizeNamePart(ctx.ext || "bin"),
  };

  let rendered = rawTemplate;
  for (const [token, value] of Object.entries(replacements)) {
    rendered = rendered.split(token).join(value);
  }

  let base = sanitizeFileName(rendered);
  if (!base) {
    base = `${sanitizeNamePart(ctx.tweetId)}-${ctx.index}-${sanitizeNamePart(ctx.mediaType || "media")}`;
  }

  const hasExt = /\.[a-zA-Z0-9]{2,5}$/.test(base);
  return hasExt ? base : `${base}.${ctx.ext}`;
}

function defaultMediaDir(): string {
  return join(import.meta.dir, "..", "data", "media");
}

function parseFlags(args: string[]): {
  target?: string;
  outDir?: string;
  maxItems?: number;
  nameTemplate?: string;
  mediaFilter: MediaFilter;
  asJson: boolean;
  help: boolean;
} {
  const positional: string[] = [];
  let outDir: string | undefined;
  let maxItems: number | undefined;
  let nameTemplate: string | undefined;
  let mediaFilter: MediaFilter = "all";
  let asJson = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--dir":
        outDir = args[++i];
        break;
      case "--max-items": {
        const parsed = parseMaxItems(args[++i]);
        if (parsed === null) {
          throw new Error("Usage: --max-items requires a positive integer.");
        }
        maxItems = parsed;
        break;
      }
      case "--name-template":
        nameTemplate = args[++i];
        if (!nameTemplate || !nameTemplate.trim()) {
          throw new Error("Usage: --name-template requires a non-empty value.");
        }
        break;
      case "--photos-only":
        if (mediaFilter === "video") {
          throw new Error("Use only one of --photos-only or --video-only.");
        }
        mediaFilter = "photos";
        break;
      case "--video-only":
        if (mediaFilter === "photos") {
          throw new Error("Use only one of --photos-only or --video-only.");
        }
        mediaFilter = "video";
        break;
      case "--json":
        asJson = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        positional.push(arg);
        break;
    }
  }

  return { target: positional[0], outDir, maxItems, nameTemplate, mediaFilter, asJson, help };
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolveFn) => setTimeout(resolveFn, ms));
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function downloadBytesWithRetry(url: string): Promise<Buffer> {
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return Buffer.from(await res.arrayBuffer());
      }

      const canRetry = shouldRetryStatus(res.status) && attempt < DOWNLOAD_ATTEMPTS;
      if (!canRetry) {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err: any) {
      if (attempt >= DOWNLOAD_ATTEMPTS) {
        throw err;
      }
    }

    const delayMs = BACKOFF_BASE_MS * 2 ** (attempt - 1);
    await sleepMs(delayMs);
  }

  throw new Error("Download failed after retries.");
}

function printHelp(): void {
  console.log(`
Usage: xint media <tweet_id|tweet_url> [options]

Download media attachments from a tweet using official X API metadata.

Options:
  --dir <path>       Output directory (default: data/media)
  --max-items <N>    Download up to N media items
  --name-template    Filename template (tokens: {tweet_id} {username} {index}
                     {type} {media_key} {created_at} {ext})
  --photos-only      Download photos only
  --video-only       Download videos/GIFs only
  --json             Output JSON summary
  --help, -h         Show this help

Examples:
  xint media 1900100012345678901
  xint media https://x.com/user/status/1900100012345678901
  xint media 1900100012345678901 --name-template "{username}-{created_at}-{index}"
  xint media 1900100012345678901 --video-only --max-items 1
  xint media 1900100012345678901 --dir ./downloads --json
`);
}

export async function cmdMedia(args: string[]): Promise<void> {
  const { target, outDir, maxItems, nameTemplate, mediaFilter, asJson, help } = parseFlags(args);
  if (help || !target) {
    printHelp();
    return;
  }

  const tweetId = extractTweetId(target);
  if (!tweetId) {
    throw new Error("Invalid tweet ID or tweet URL.");
  }

  const outputDir = resolve(outDir || defaultMediaDir());
  mkdirSync(outputDir, { recursive: true });

  const query =
    "expansions=attachments.media_keys,author_id&tweet.fields=attachments,author_id,created_at&user.fields=username&media.fields=type,url,preview_image_url,variants,width,height,duration_ms,alt_text";
  const url = `${BASE}/tweets/${tweetId}?${query}`;
  const raw = await bearerGet(url);
  trackCost("media_metadata", `/2/tweets/${tweetId}`, 1);

  const mediaList: RawMedia[] = Array.isArray((raw as any)?.includes?.media)
    ? (raw as any).includes.media
    : [];
  const users = Array.isArray((raw as any)?.includes?.users) ? (raw as any).includes.users : [];
  const authorId = (raw as any)?.data?.author_id;
  const createdAt = typeof (raw as any)?.data?.created_at === "string" ? (raw as any).data.created_at : undefined;
  const username = users.find((u: any) => u.id === authorId)?.username || null;

  if (mediaList.length === 0) {
    console.log("No media attachments found on this tweet.");
    return;
  }

  const selectedMedia = mediaList.filter((m) => matchesMediaFilter(m, mediaFilter));
  const limitedMedia = maxItems ? selectedMedia.slice(0, maxItems) : selectedMedia;
  if (limitedMedia.length === 0) {
    console.log("No media attachments matched the selected filters.");
    return;
  }

  const records: DownloadRecord[] = [];

  for (let i = 0; i < limitedMedia.length; i++) {
    const media = limitedMedia[i];
    const sourceUrl = selectDownloadUrl(media);
    const baseRecord: DownloadRecord = {
      mediaKey: media.media_key,
      type: media.type,
      sourceUrl: sourceUrl || undefined,
    };

    if (!sourceUrl) {
      records.push({ ...baseRecord, error: "No downloadable URL found" });
      continue;
    }

    try {
      const bytes = await downloadBytesWithRetry(sourceUrl);
      const ext = inferExtension(sourceUrl, media.type);
      const fileName = renderFileNameTemplate(nameTemplate, {
        tweetId,
        username: username || undefined,
        index: i + 1,
        mediaType: media.type || "media",
        mediaKey: media.media_key || "unknown",
        createdAt,
        ext,
      });
      const path = join(outputDir, fileName);
      writeFileSync(path, bytes);

      records.push({
        ...baseRecord,
        savedPath: path,
        bytes: bytes.length,
      });
    } catch (err: any) {
      records.push({
        ...baseRecord,
        error: err?.message || String(err),
      });
    }
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          tweetId,
          username,
          outputDir,
          totalMedia: mediaList.length,
          selectedMedia: limitedMedia.length,
          nameTemplate: nameTemplate || DEFAULT_NAME_TEMPLATE,
          downloaded: records.filter((r) => !r.error).length,
          records,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\n🎞️  Media download for tweet ${tweetId}${username ? ` (@${username})` : ""}`);
  console.log(`Output directory: ${outputDir}`);
  console.log(`Attachments found: ${mediaList.length} (selected: ${limitedMedia.length})\n`);

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.error) {
      console.log(`${i + 1}. ❌ ${rec.type} (${rec.mediaKey}) — ${rec.error}`);
      continue;
    }
    console.log(`${i + 1}. ✅ ${rec.type} (${rec.mediaKey})`);
    console.log(`   ${rec.savedPath} (${rec.bytes} bytes)`);
  }

  const success = records.filter((r) => !r.error).length;
  const failed = records.length - success;
  console.log(`\nDone: ${success} downloaded, ${failed} failed.`);
}
