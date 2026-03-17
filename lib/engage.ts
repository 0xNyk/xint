/**
 * lib/engage.ts — Strategic engagement command.
 * Discover high-engagement tweets, generate AI replies, optionally post.
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { BASE, getTweet, oauthGet, parseSince, parseTweets, sleep } from "./api";
import type { Tweet } from "./api";
import { getValidToken, loadTokens } from "./oauth";
import { xSearch } from "./x_search";
import { getUserTimeline } from "./timeline";
import { grokChat } from "./grok";
import type { GrokOpts } from "./grok";
import { replyToTweet } from "./engagement";
import { trackCost } from "./costs";
import { createSpinner } from "./spinner";
import { bold, cyan, dim, green, yellow } from "./format";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContentItem {
  url: string;
  text_preview: string;
  topics: string[];
  source: "timeline" | "bookmark-kb" | "explicit";
}

interface ReplySuggestion {
  target_tweet_id: string;
  target_tweet_url: string;
  target_author: string;
  target_text: string;
  target_metrics: { likes: number; retweets: number; impressions: number };
  reply_text: string;
  linked_content_url: string | null;
  link_reason: string | null;
  confidence: number;
}

interface EngagePlan {
  generated_at: string;
  niche: string;
  model: string;
  suggestions: ReplySuggestion[];
  executed: boolean;
  execution_results?: Array<{ tweet_id: string; reply_id: string; success: boolean }>;
}

// ---------------------------------------------------------------------------
// Bookmark KB loader (inline to avoid circular dep)
// ---------------------------------------------------------------------------

interface BookmarkExtraction {
  tweet_id: string;
  tweet_url: string;
  topics: string[];
  summary: string;
  importance: number;
  urls: string[];
}

interface BookmarkKB {
  extractions: BookmarkExtraction[];
}

const KB_PATH = join(import.meta.dir, "..", "data", "bookmark-kb.json");

function loadKB(): BookmarkKB | null {
  if (!existsSync(KB_PATH)) return null;
  try {
    const raw = require("fs").readFileSync(KB_PATH, "utf-8");
    return JSON.parse(raw) as BookmarkKB;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Growth Dashboard SQLite loader (optional)
// ---------------------------------------------------------------------------

async function loadGrowthDashboardLinks(): Promise<ContentItem[]> {
  const dbPaths = [
    join(import.meta.dir, "..", "..", "nyk-growth-dashboard", "data", "growth.db"),
    join(import.meta.dir, "..", "..", "nyk-growth-dashboard", "growth.db"),
  ];

  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;
    try {
      const db = new (await import("bun:sqlite")).Database(dbPath, { readonly: true });
      // Try to find top-performing content links
      const rows = db.query(
        `SELECT url, title, description FROM content
         WHERE url IS NOT NULL
         ORDER BY engagement_score DESC
         LIMIT 20`
      ).all() as Array<{ url: string; title?: string; description?: string }>;
      db.close();

      if (rows.length > 0) {
        return rows.map(r => ({
          url: r.url,
          text_preview: r.title || r.description || r.url,
          topics: [],
          source: "timeline" as const,
        }));
      }
    } catch {
      // DB schema may differ or bun:sqlite unavailable — silently skip
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function extractTweetIdFromUrl(url: string): string | null {
  const m = url.match(/status\/(\d+)/);
  return m ? m[1] : null;
}

function stripMarkdownFences(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/gm, "").replace(/\n?```\s*$/gm, "").trim();
}

function confidenceBar(score: number): string {
  const filled = Math.round(score);
  const empty = 5 - filled;
  return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

// ---------------------------------------------------------------------------
// Core command
// ---------------------------------------------------------------------------

export async function cmdEngage(args: string[]): Promise<void> {
  // Parse flags
  const niche = getFlag(args, "--niche");
  const count = parseInt(getFlag(args, "--count") || "1");
  const since = getFlag(args, "--since") || "1d";
  const linksRaw = getFlag(args, "--links");
  const execute = hasFlag(args, "--execute");
  const save = hasFlag(args, "--save");
  const json = hasFlag(args, "--json");
  const model = getFlag(args, "--model") || "grok-4-1-fast";
  const noKb = hasFlag(args, "--no-kb");

  if (!niche) {
    console.error("Usage: xint engage --niche <keywords> [options]");
    console.error("");
    console.error("Options:");
    console.error("  --niche <keywords>    Niche/topic keywords (required)");
    console.error("  --count <N>           Number of targets (default: 1)");
    console.error("  --since <dur>         How far back (default: 1d)");
    console.error("  --links <url1,url2>   Explicit URLs to promote");
    console.error("  --execute             Actually post replies (dry-run by default)");
    console.error("  --save                Save plan to data/exports/");
    console.error("  --json                JSON output");
    console.error("  --model <name>        Grok model (default: grok-4-1-fast)");
    console.error("  --no-kb               Skip bookmark-kb lookup");
    console.error("");
    console.error("Examples:");
    console.error('  xint engage --niche "AI agents" --count 5');
    console.error('  xint engage --niche "typescript" --links "https://x.com/user/status/123"');
    console.error('  xint engage --niche "AI" --execute --count 1');
    process.exit(1);
  }

  // 1. Auth
  const tokens = loadTokens();
  if (!tokens) throw new Error("Not authenticated. Run 'auth setup' first.");
  const accessToken = await getValidToken();
  const userId = tokens.user_id;

  // 2. Discover tweets via xSearch
  const spinner = createSpinner("Discovering high-engagement tweets...");

  let targetTweets: Tweet[] = [];
  try {
    const fromDate = parseSince(since);
    const searchQuery = `popular ${niche} tweets with many likes`;
    const searchResult = await xSearch(searchQuery, {
      maxResults: Math.max(count * 3, 10),
      fromDate: fromDate ? fromDate.split("T")[0] : undefined,
      timeoutSeconds: 60,
      model: "grok-4-1-fast",
    });

    // Extract tweet IDs from xSearch results + citations
    const tweetIds: string[] = [];
    for (const r of searchResult.results) {
      const url = r.url || r.tweet_url || r.link || "";
      const id = extractTweetIdFromUrl(url);
      if (id && !tweetIds.includes(id)) tweetIds.push(id);
    }
    // Also check citations for tweet URLs
    for (const c of searchResult.citations) {
      const id = extractTweetIdFromUrl(c.url);
      if (id && !tweetIds.includes(id)) tweetIds.push(id);
    }

    spinner.update(`Enriching ${tweetIds.length} tweets with metrics...`);

    // Fetch each tweet for exact metrics
    const enriched: Tweet[] = [];
    for (const id of tweetIds.slice(0, count * 2)) {
      try {
        const tweet = await getTweet(id);
        if (tweet) enriched.push(tweet);
      } catch {
        // Skip tweets that can't be fetched (deleted, private)
      }
    }

    // Also discover from home feed (accounts user follows)
    try {
      spinner.update("Scanning home feed for niche tweets...");
      const nicheWords = niche.toLowerCase().split(/\s+/);
      const feedUrl = `${BASE}/users/${userId}/timelines/reverse_chronological?max_results=100&${
        "tweet.fields=created_at,public_metrics,entities,note_tweet&expansions=author_id&user.fields=username,name,public_metrics"
      }`;
      const feedResp = await oauthGet(feedUrl, accessToken);
      if (feedResp?.data && Array.isArray(feedResp.data)) {
        const feedTweets = parseTweets(feedResp);
        const seenIds = new Set(enriched.map(t => t.id));
        for (const t of feedTweets) {
          if (seenIds.has(t.id)) continue;
          // Filter: must match niche keywords and have decent engagement
          const textLower = t.text.toLowerCase();
          const matchesNiche = nicheWords.some(w => textLower.includes(w));
          const engagement = (t.metrics.likes || 0) + (t.metrics.retweets || 0);
          if (matchesNiche && engagement >= 5) {
            enriched.push(t);
            seenIds.add(t.id);
          }
        }
      }
    } catch {
      // Home feed fetch may fail — continue with xSearch results only
    }

    // Sort by engagement (likes + bookmarks + retweets)
    enriched.sort((a, b) => {
      const scoreA = (a.metrics.likes || 0) + (a.metrics.retweets || 0) + (a.metrics.bookmarks || 0);
      const scoreB = (b.metrics.likes || 0) + (b.metrics.retweets || 0) + (b.metrics.bookmarks || 0);
      return scoreB - scoreA;
    });
    targetTweets = enriched.slice(0, count);
  } catch (err: any) {
    spinner.fail("Discovery failed");
    throw new Error(`Discovery failed: ${err.message}`);
  }

  if (targetTweets.length === 0) {
    spinner.fail("No tweets found");
    console.error("No tweets found for the given niche. Try broader keywords or a longer time window.");
    return;
  }

  spinner.update(`Found ${targetTweets.length} targets. Loading your content...`);

  // 3. Load user content pool
  const contentPool: ContentItem[] = [];

  // Explicit links (highest priority)
  if (linksRaw) {
    for (const url of linksRaw.split(",").map(u => u.trim()).filter(Boolean)) {
      contentPool.push({ url, text_preview: url, topics: [], source: "explicit" });
    }
  }

  // User timeline (recent original tweets)
  try {
    const timeline = await getUserTimeline(userId, accessToken, {
      since: "30d",
      pages: 3,
      exclude: ["replies", "retweets"],
    });
    for (const t of timeline) {
      const url = t.tweet_url || `https://x.com/i/status/${t.id}`;
      contentPool.push({
        url,
        text_preview: t.text.slice(0, 200),
        topics: [],
        source: "timeline",
      });
    }
  } catch {
    // Timeline fetch may fail if no OAuth — continue without it
  }

  // Bookmark KB entries
  if (!noKb) {
    const kb = loadKB();
    if (kb) {
      for (const ext of kb.extractions.filter(e => e.importance >= 3)) {
        const url = ext.tweet_url || (ext.urls.length > 0 ? ext.urls[0] : "");
        if (!url) continue;
        contentPool.push({
          url,
          text_preview: ext.summary.slice(0, 200),
          topics: ext.topics,
          source: "bookmark-kb",
        });
      }
    }
  }

  // Growth dashboard links (optional)
  try {
    const dashLinks = await loadGrowthDashboardLinks();
    contentPool.push(...dashLinks);
  } catch {
    // Growth dashboard not available — skip silently
  }

  spinner.update("Generating reply suggestions with Grok...");

  // 4. Generate replies via Grok
  const targetData = targetTweets.map(t => ({
    id: t.id,
    url: t.tweet_url || `https://x.com/i/status/${t.id}`,
    author: t.username || t.author_id || "unknown",
    text: t.text.slice(0, 500),
    metrics: {
      likes: t.metrics.likes || 0,
      retweets: t.metrics.retweets || 0,
      impressions: t.metrics.impressions || 0,
    },
  }));

  const contentData = contentPool.slice(0, 30).map(c => ({
    url: c.url,
    text_preview: c.text_preview.slice(0, 200),
    topics: c.topics.slice(0, 5),
    source: c.source,
  }));

  const systemPrompt = `You are a strategic engagement advisor for X/Twitter. For each target tweet, craft a reply that:
1. Adds genuine value (insight, data, different angle, practical tip)
2. Naturally includes the linked URL INSIDE the reply_text itself (at the end or woven in) so the reply is copy-paste ready
3. Does NOT feel like spam or self-promotion
4. Is concise (under 280 chars preferred, 400 max)
5. Matches the tone of the original tweet

IMPORTANT: The reply_text MUST contain the full link URL if one is chosen. The user will copy-paste reply_text directly.

Return ONLY a JSON array (no markdown fences): [{ "target_tweet_id": "...", "reply_text": "...", "linked_content_url": "..." or null, "link_reason": "..." or null, "confidence": 1-5 }]
confidence: 1-5 (5 = perfect fit). Set linked_content_url to null if nothing fits naturally.`;

  const userPrompt = `Target tweets:\n${JSON.stringify(targetData, null, 2)}\n\nUser's content pool:\n${JSON.stringify(contentData, null, 2)}`;

  let suggestions: ReplySuggestion[] = [];
  try {
    const grokResp = await grokChat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { model, maxTokens: 4096, temperature: 0.7 },
    );

    const cleaned = stripMarkdownFences(grokResp.content);
    const parsed = JSON.parse(cleaned) as Array<{
      target_tweet_id: string;
      reply_text: string;
      linked_content_url: string | null;
      link_reason: string | null;
      confidence: number;
    }>;

    // Merge with target tweet data
    for (const p of parsed) {
      const target = targetData.find(t => t.id === p.target_tweet_id);
      if (!target) continue;
      suggestions.push({
        target_tweet_id: p.target_tweet_id,
        target_tweet_url: target.url,
        target_author: target.author,
        target_text: target.text,
        target_metrics: target.metrics,
        reply_text: p.reply_text,
        linked_content_url: p.linked_content_url,
        link_reason: p.link_reason,
        confidence: Math.min(5, Math.max(1, p.confidence || 3)),
      });
    }
  } catch (err: any) {
    spinner.fail("Reply generation failed");
    throw new Error(`Reply generation failed: ${err.message}`);
  }

  spinner.done("Suggestions ready");

  if (suggestions.length === 0) {
    console.error("No reply suggestions generated. Try different niche keywords.");
    return;
  }

  // 5. Display
  const plan: EngagePlan = {
    generated_at: new Date().toISOString(),
    niche,
    model,
    suggestions,
    executed: false,
  };

  if (json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(`\n${bold("Engage Plan")} — ${cyan(niche)} (${suggestions.length} suggestions)\n`);

    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i];
      const metrics = dim(`${s.target_metrics.likes}\u2665 ${s.target_metrics.retweets}RT ${s.target_metrics.impressions}I`);
      console.log(`${bold(`${i + 1}.`)} ${bold(`@${s.target_author}`)} ${metrics}`);
      console.log(`   ${dim(s.target_text.slice(0, 200))}`);
      console.log();
      console.log(`   ${yellow("Comment on:")} ${s.target_tweet_url}`);
      console.log();
      console.log(`   ${yellow("Reply to paste:")}`);
      console.log(`   ${green(s.reply_text)}`);
      if (s.linked_content_url) {
        console.log();
        console.log(`   ${dim(`Link reason: ${s.link_reason || "relevant content"}`)}`);
      }
      console.log();
      console.log(`   ${yellow("Confidence:")} ${confidenceBar(s.confidence)} ${s.confidence}/5`);
      console.log();
    }
  }

  // 6. Execute (if --execute)
  if (execute) {
    console.log(bold("\nExecuting replies...\n"));
    const results: Array<{ tweet_id: string; reply_id: string; success: boolean }> = [];

    for (const s of suggestions) {
      try {
        const result = await replyToTweet(s.target_tweet_id, s.reply_text, accessToken);
        results.push({ tweet_id: s.target_tweet_id, reply_id: result.id, success: true });
        console.log(green(`\u2705 Replied to @${s.target_author}: ${result.id}`));
        trackCost("engage_reply", "/2/tweets", 0);
        // Delay between replies to avoid spam detection
        if (suggestions.indexOf(s) < suggestions.length - 1) {
          await sleep(2000);
        }
      } catch (err: any) {
        results.push({ tweet_id: s.target_tweet_id, reply_id: "", success: false });
        console.error(`\u274C Failed to reply to @${s.target_author}: ${err.message}`);
      }
    }

    plan.executed = true;
    plan.execution_results = results;

    const succeeded = results.filter(r => r.success).length;
    console.log(`\n${bold("Results:")} ${succeeded}/${results.length} replies posted`);
  }

  // 7. Save (if --save)
  if (save) {
    const exportsDir = join(import.meta.dir, "..", "data", "exports");
    mkdirSync(exportsDir, { recursive: true });
    const filename = `engage-plan-${new Date().toISOString().split("T")[0]}.json`;
    const filepath = join(exportsDir, filename);
    Bun.write(filepath, JSON.stringify(plan, null, 2));
    console.error(`\n\uD83D\uDCC1 Plan saved to ${filepath}`);
  }

  if (!execute) {
    console.error(dim("\n\uD83D\uDCA1 Dry-run mode. Add --execute to post replies."));
  }
}
