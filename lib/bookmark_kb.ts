import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { fetchBookmarks } from "./bookmarks";
import { getValidToken, loadTokens } from "./oauth";
import { grokChat } from "./grok";
import type { GrokOpts } from "./grok";
import { trackCost } from "./costs";
import { collectionsEnsure, collectionsUploadDocument, documentsSearch } from "./collections";
import { createSpinner } from "./spinner";

interface SourceLink {
  url: string;
  title?: string;
  domain?: string;
}

interface BookmarkExtraction {
  tweet_id: string;
  tweet_url: string;
  author: string;
  text_preview: string;
  topics: string[];
  entities: string[];
  summary: string;
  evaluation: string;
  sentiment: string;
  importance: number;
  key_insights: string[];
  source_links: SourceLink[];
  urls: string[];
  extracted_at: string;
}

interface BookmarkKnowledgeBase {
  version: number;
  last_extracted: string;
  total_bookmarks_processed: number;
  extractions: BookmarkExtraction[];
  topic_index: Record<string, string[]>;
  collection_id?: string;
  last_synced?: string;
}

const KB_PATH = join(import.meta.dir, "..", "data", "bookmark-kb.json");

function loadKB(): BookmarkKnowledgeBase | null {
  if (!existsSync(KB_PATH)) return null;
  try {
    const raw = require("fs").readFileSync(KB_PATH, "utf-8");
    return JSON.parse(raw) as BookmarkKnowledgeBase;
  } catch {
    return null;
  }
}

function saveKB(kb: BookmarkKnowledgeBase): void {
  const dir = join(import.meta.dir, "..", "data");
  mkdirSync(dir, { recursive: true });
  Bun.write(KB_PATH, JSON.stringify(kb, null, 2));
}

function rebuildTopicIndex(extractions: BookmarkExtraction[]): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  for (const ext of extractions) {
    for (const topic of ext.topics) {
      const key = topic.toLowerCase();
      if (!index[key]) index[key] = [];
      if (!index[key].includes(ext.tweet_id)) index[key].push(ext.tweet_id);
    }
  }
  return index;
}

function getFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

export async function cmdBookmarkKb(args: string[]): Promise<void> {
  const sub = args[0] || "help";

  try {
    switch (sub) {
      case "extract":
        await subExtract(args.slice(1));
        break;
      case "search":
        await subSearch(args.slice(1));
        break;
      case "sync":
        await subSync(args.slice(1));
        break;
      case "topics":
        subTopics(args.slice(1));
        break;
      case "status":
        subStatus(args.slice(1));
        break;
      case "help":
      case "--help":
      case "-h":
        printHelp();
        break;
      default:
        console.error(`Unknown subcommand: ${sub}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}

async function subExtract(args: string[]): Promise<void> {
  const limit = parseInt(getFlag(args, "--limit") || "100");
  const batchSize = parseInt(getFlag(args, "--batch-size") || "20");
  const model = getFlag(args, "--model") || "grok-4-1-fast";
  const force = hasFlag(args, "--force");
  const asJson = hasFlag(args, "--json");

  const accessToken = await getValidToken();
  const tokens = loadTokens()!;

  const spinner = createSpinner("Fetching bookmarks...");
  const tweets = await fetchBookmarks(tokens.user_id, accessToken, limit);
  trackCost("bookmarks", `/2/users/me/bookmarks`, tweets.length);

  if (tweets.length === 0) {
    spinner.done("No bookmarks found.");
    return;
  }
  spinner.done(`Fetched ${tweets.length} bookmarks`);

  let kb = loadKB() || {
    version: 1,
    last_extracted: "",
    total_bookmarks_processed: 0,
    extractions: [],
    topic_index: {},
  };

  const existingIds = new Set(kb.extractions.map((e) => e.tweet_id));
  const toProcess = force
    ? tweets
    : tweets.filter((t) => !existingIds.has(t.id));

  if (toProcess.length === 0) {
    console.error("All bookmarks already extracted. Use --force to re-extract.");
    return;
  }

  console.error(`Extracting knowledge from ${toProcess.length} bookmarks...`);

  const existingTopics = Object.keys(kb.topic_index);
  const batches: typeof toProcess[] = [];
  for (let i = 0; i < toProcess.length; i += batchSize) {
    batches.push(toProcess.slice(i, i + batchSize));
  }

  const grokOpts: GrokOpts = { model, temperature: 0.3, maxTokens: 2048 };
  let processed = 0;

  for (const batch of batches) {
    const batchSpinner = createSpinner(`Processing batch ${Math.floor(processed / batchSize) + 1}/${batches.length}...`);

    const tweetContext = batch.map((t) => {
      const url = `https://x.com/${t.username}/status/${t.id}`;
      const links = (t.urls || [])
        .map((u: any) => {
          const expanded = u.unwound_url || u.url;
          const title = u.title ? ` (${u.title})` : "";
          return `  - ${expanded}${title}`;
        })
        .join("\n");
      const linksSection = links ? `\nLinks:\n${links}` : "";
      return `Tweet ${t.id} by @${t.username} (${url}):\n${t.text}${linksSection}\n---`;
    }).join("\n\n");

    const systemPrompt = `You are a knowledge extraction engine. Given these tweets, extract structured knowledge for each one.

For each tweet, output:
- topics: 2-5 categories (use consistent naming, prefer existing topics: ${existingTopics.join(", ") || "none yet"})
- entities: people, companies, products, technologies mentioned
- summary: 1-2 sentence summary of the key information
- evaluation: 1-2 sentence assessment of why this bookmark is valuable, what makes it worth saving, and how it could be applied or referenced later
- sentiment: positive/negative/neutral/mixed
- importance: 1-5 (5 = highly actionable/valuable)
- key_insights: 1-3 bullet points of the most valuable takeaways

Return a JSON array of objects with fields: tweet_id, topics, entities, summary, evaluation, sentiment, importance, key_insights

IMPORTANT: Return ONLY valid JSON. No markdown fences, no explanation.`;

    const response = await grokChat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: tweetContext },
      ],
      grokOpts,
    );

    trackCost("bookmark_kb_extract", "xai/grok", 0);

    let parsed: any[];
    try {
      const content = response.content.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
      parsed = JSON.parse(content);
    } catch {
      batchSpinner.fail(`Failed to parse Grok response for batch`);
      continue;
    }

    for (const item of parsed) {
      const tweet = batch.find((t) => t.id === item.tweet_id);
      if (!tweet) continue;

      const url = `https://x.com/${tweet.username}/status/${tweet.id}`;
      const sourceLinks: SourceLink[] = (tweet.urls || []).map((u: any) => ({
        url: u.unwound_url || u.url,
        title: u.title || undefined,
        domain: (u.unwound_url || u.url || "").replace(/^https?:\/\//, "").split("/")[0] || undefined,
      }));
      const rawUrls = sourceLinks.map((l) => l.url);

      const extraction: BookmarkExtraction = {
        tweet_id: tweet.id,
        tweet_url: url,
        author: `@${tweet.username}`,
        text_preview: tweet.text.slice(0, 200),
        topics: item.topics || [],
        entities: item.entities || [],
        summary: item.summary || "",
        evaluation: item.evaluation || "",
        sentiment: item.sentiment || "neutral",
        importance: item.importance || 3,
        key_insights: item.key_insights || [],
        source_links: sourceLinks,
        urls: rawUrls,
        extracted_at: new Date().toISOString(),
      };

      if (force) {
        const idx = kb.extractions.findIndex((e) => e.tweet_id === tweet.id);
        if (idx >= 0) kb.extractions[idx] = extraction;
        else kb.extractions.push(extraction);
      } else {
        kb.extractions.push(extraction);
      }
    }

    processed += batch.length;
    batchSpinner.done(`Batch ${Math.floor(processed / batchSize)}/${batches.length} done (${parsed.length} extracted)`);
  }

  kb.topic_index = rebuildTopicIndex(kb.extractions);
  kb.last_extracted = new Date().toISOString();
  kb.total_bookmarks_processed = kb.extractions.length;
  saveKB(kb);

  if (asJson) {
    console.log(JSON.stringify(kb, null, 2));
  } else {
    console.log(`\nExtraction complete:`);
    console.log(`  Processed: ${toProcess.length} bookmarks`);
    console.log(`  Total in KB: ${kb.extractions.length}`);
    console.log(`  Topics discovered: ${Object.keys(kb.topic_index).length}`);
  }
}

async function subSearch(args: string[]): Promise<void> {
  // Extract positional args, skipping flag values
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      if (!["--json", "--remote"].includes(args[i]) && i + 1 < args.length) i++; // skip value
    } else {
      positional.push(args[i]);
    }
  }
  const query = positional.join(" ");
  if (!query) {
    console.error("Usage: bookmark-kb search <query> [--topic <t>] [--min-importance <n>] [--limit <n>] [--remote] [--json]");
    process.exit(1);
  }

  const topicFilter = getFlag(args, "--topic");
  const minImportance = parseInt(getFlag(args, "--min-importance") || "0");
  const resultLimit = parseInt(getFlag(args, "--limit") || "10");
  const remote = hasFlag(args, "--remote");
  const asJson = hasFlag(args, "--json");

  if (remote) {
    const kb = loadKB();
    const collectionId = kb?.collection_id;
    const ids = collectionId ? [collectionId] : [];
    const results = await documentsSearch(query, ids);
    if (asJson) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      for (const r of results.results || []) {
        console.log(`[${(r.score || 0).toFixed(3)}] ${r.content?.slice(0, 200) || r.id}`);
        console.log();
      }
    }
    return;
  }

  const kb = loadKB();
  if (!kb || kb.extractions.length === 0) {
    console.error("Knowledge base is empty. Run: bookmark-kb extract");
    return;
  }

  const q = query.toLowerCase();
  let results = kb.extractions.map((ext) => {
    let score = 0;
    if (ext.summary.toLowerCase().includes(q)) score += 3;
    for (const insight of ext.key_insights) {
      if (insight.toLowerCase().includes(q)) score += 2;
    }
    for (const topic of ext.topics) {
      if (topic.toLowerCase().includes(q)) score += 2;
    }
    for (const entity of ext.entities) {
      if (entity.toLowerCase().includes(q)) score += 1;
    }
    if (ext.text_preview.toLowerCase().includes(q)) score += 1;
    if (ext.evaluation && ext.evaluation.toLowerCase().includes(q)) score += 2;
    return { ext, score };
  }).filter((r) => r.score > 0);

  if (topicFilter) {
    const tf = topicFilter.toLowerCase();
    results = results.filter((r) => r.ext.topics.some((t) => t.toLowerCase().includes(tf)));
  }

  if (minImportance > 0) {
    results = results.filter((r) => r.ext.importance >= minImportance);
  }

  results.sort((a, b) => b.score - a.score || b.ext.importance - a.ext.importance);
  const shown = results.slice(0, resultLimit);

  if (shown.length === 0) {
    console.log("No results found.");
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(shown.map((r) => r.ext), null, 2));
  } else {
    for (const { ext, score } of shown) {
      console.log(`[${ext.importance}/5] ${ext.author} — ${ext.summary}`);
      if (ext.evaluation) {
        console.log(`  Evaluation: ${ext.evaluation}`);
      }
      if (ext.key_insights.length > 0) {
        for (const insight of ext.key_insights) {
          console.log(`  - ${insight}`);
        }
      }
      if (ext.source_links && ext.source_links.length > 0) {
        console.log(`  Sources:`);
        for (const link of ext.source_links) {
          const label = link.title ? `${link.title} (${link.domain})` : link.url;
          console.log(`    ${label}`);
        }
      }
      console.log(`  Topics: ${ext.topics.join(", ")} | ${ext.tweet_url}`);
      console.log();
    }
    console.log(`${shown.length} results (of ${results.length} matches)`);
  }
}

async function subSync(args: string[]): Promise<void> {
  const cloud = hasFlag(args, "--cloud");
  const kb = loadKB();
  if (!kb || kb.extractions.length === 0) {
    console.error("Knowledge base is empty. Run: bookmark-kb extract");
    return;
  }

  const byTopic: Record<string, BookmarkExtraction[]> = {};
  for (const ext of kb.extractions) {
    for (const topic of ext.topics) {
      const key = topic.toLowerCase();
      if (!byTopic[key]) byTopic[key] = [];
      byTopic[key].push(ext);
    }
  }

  const exportDir = join(import.meta.dir, "..", "data", "exports", "bookmark-kb");
  mkdirSync(exportDir, { recursive: true });

  const topics = Object.keys(byTopic).sort();

  for (const topic of topics) {
    const exts = byTopic[topic];
    const lines: string[] = [`# ${topic}\n`];
    for (const ext of exts) {
      lines.push(`## ${ext.author} (importance: ${ext.importance}/5)`);
      lines.push(ext.summary);
      if (ext.evaluation) {
        lines.push(`\n> ${ext.evaluation}\n`);
      }
      if (ext.key_insights.length > 0) {
        for (const insight of ext.key_insights) {
          lines.push(`- ${insight}`);
        }
      }
      lines.push(`\nEntities: ${ext.entities.join(", ")}`);
      if (ext.source_links && ext.source_links.length > 0) {
        lines.push("Links:");
        for (const link of ext.source_links) {
          lines.push(`  - ${link.title ? `[${link.title}](${link.url})` : link.url}`);
        }
      }
      lines.push(`Source: ${ext.tweet_url}\n`);
    }

    const filename = `${topic.replace(/[^a-z0-9]+/gi, "-")}.md`;
    const filePath = join(exportDir, filename);
    await Bun.write(filePath, lines.join("\n"));
    console.error(`  Exported: ${filename} (${exts.length} entries)`);
  }

  console.log(`\nExported ${topics.length} topic files to data/exports/bookmark-kb/`);

  if (cloud) {
    const spinner = createSpinner("Ensuring collection...");
    const { collection, created } = await collectionsEnsure("xint-bookmarks", "Bookmark knowledge base");
    spinner.done(created ? `Created collection: ${collection.id}` : `Using collection: ${collection.id}`);

    let uploaded = 0;
    for (const topic of topics) {
      const safeName = topic.replace(/[^a-z0-9]+/gi, "-");
      const filename = `${safeName}.md`;
      const filePath = join(exportDir, filename);
      try {
        await collectionsUploadDocument(collection.id, filePath, safeName, "text/markdown");
        uploaded++;
        console.error(`  Uploaded: ${filename}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Failed: ${filename} — ${msg}`);
      }
    }

    kb.collection_id = collection.id;
    kb.last_synced = new Date().toISOString();
    saveKB(kb);

    console.log(`Uploaded ${uploaded}/${topics.length} topics to collection ${collection.id}`);
  }
}

function subTopics(args: string[]): void {
  const asJson = hasFlag(args, "--json");
  const kb = loadKB();
  if (!kb || Object.keys(kb.topic_index).length === 0) {
    console.error("No topics found. Run: bookmark-kb extract");
    return;
  }

  const sorted = Object.entries(kb.topic_index)
    .sort((a, b) => b[1].length - a[1].length);

  if (asJson) {
    console.log(JSON.stringify(sorted.map(([topic, ids]) => ({ topic, count: ids.length, tweet_ids: ids })), null, 2));
    return;
  }

  console.log("Topic                          Count");
  console.log("-----                          -----");
  for (const [topic, ids] of sorted) {
    console.log(`${topic.padEnd(30)} ${ids.length}`);
  }
  console.log(`\nTotal: ${sorted.length} topics across ${kb.extractions.length} extractions`);
}

function subStatus(args: string[]): void {
  const asJson = hasFlag(args, "--json");
  const kb = loadKB();
  if (!kb) {
    console.log("Knowledge base not initialized. Run: bookmark-kb extract");
    return;
  }

  if (asJson) {
    console.log(JSON.stringify({
      extractions: kb.extractions.length,
      topics: Object.keys(kb.topic_index).length,
      last_extracted: kb.last_extracted || null,
      collection_id: kb.collection_id || null,
      last_synced: kb.last_synced || null,
    }, null, 2));
    return;
  }

  console.log("Bookmark Knowledge Base Status");
  console.log(`  Extractions: ${kb.extractions.length}`);
  console.log(`  Topics: ${Object.keys(kb.topic_index).length}`);
  console.log(`  Last extracted: ${kb.last_extracted || "never"}`);
  console.log(`  Collection ID: ${kb.collection_id || "not synced"}`);
  console.log(`  Last synced: ${kb.last_synced || "never"}`);
}

function printHelp(): void {
  console.log(`
Bookmark Knowledge Base — extract and search knowledge from bookmarks

Usage: xint bookmark-kb <subcommand> [options]
       xint bkb <subcommand> [options]

Subcommands:
  extract                Extract knowledge from bookmarks via Grok AI
  search <query>         Search local knowledge base
  sync                   Export knowledge as markdown files
  topics                 List discovered topics with counts
  status                 Show KB stats

Extract options:
  --limit <N>            Max bookmarks to fetch (default: 100)
  --batch-size <N>       Tweets per Grok call (default: 20)
  --model <name>         Grok model (default: grok-4-1-fast)
  --force                Re-extract already processed bookmarks
  --json                 Output full KB as JSON

Search options:
  --topic <topic>        Filter by topic
  --min-importance <N>   Minimum importance (1-5)
  --limit <N>            Max results (default: 10)
  --remote               Search xAI Collections instead of local KB
  --json                 Output as JSON

Sync options:
  --cloud                Also upload to xAI Collections (requires management key)
`);
}
