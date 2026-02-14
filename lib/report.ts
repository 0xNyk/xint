/**
 * lib/report.ts — Automated intelligence reports.
 *
 * Combines search, sentiment analysis, and Grok analysis into
 * a single comprehensive markdown report.
 */

import { writeFileSync } from "fs";
import { join } from "path";
import * as api from "./api";
import { analyzeSentiment, computeStats, enrichTweets, type EnrichedTweet } from "./sentiment";
import { analyzeQuery, type GrokOpts } from "./grok";
import { trackCost } from "./costs";
import { formatTweetMarkdown } from "./format";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReportOpts {
  accounts?: string[];     // additional accounts to include
  sentiment?: boolean;     // run sentiment analysis
  model?: string;          // Grok model for analysis
  pages?: number;          // search pages
  save?: boolean;          // save to file
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

export async function generateReport(query: string, opts: ReportOpts = {}): Promise<string> {
  const date = new Date().toISOString().split("T")[0];
  const time = new Date().toISOString().replace("T", " ").slice(0, 19);
  const sections: string[] = [];

  console.error(`Generating report: "${query}"...`);

  // ---- 1. Main topic search ----
  console.error(`  Searching "${query}"...`);
  const tweets = await api.search(query, {
    pages: opts.pages || 2,
    sortOrder: "relevancy",
    since: "1d",
  });
  trackCost("search", "/2/tweets/search/recent", tweets.length);

  const topTweets = api.sortBy(tweets, "likes").slice(0, 20);

  // ---- 2. Account-specific searches ----
  const accountTweets: Record<string, api.Tweet[]> = {};
  if (opts.accounts && opts.accounts.length > 0) {
    for (const acct of opts.accounts) {
      const username = acct.replace(/^@/, "");
      console.error(`  Checking @${username}...`);
      try {
        const { tweets: userTweets } = await api.profile(username, { count: 10 });
        trackCost("profile", `/2/users/by/username/${username}`, userTweets.length + 1);
        accountTweets[username] = userTweets;
      } catch (e: any) {
        console.error(`  Warning: @${username}: ${e.message}`);
      }
    }
  }

  // ---- 3. Sentiment analysis ----
  let sentimentSection = "";
  if (opts.sentiment && topTweets.length > 0) {
    console.error(`  Running sentiment analysis...`);
    try {
      const sentiments = await analyzeSentiment(topTweets, { model: opts.model });
      const stats = computeStats(sentiments);
      const enriched = enrichTweets(topTweets, sentiments);

      sentimentSection += `## Sentiment Analysis\n\n`;
      sentimentSection += `**Average score:** ${stats.average_score.toFixed(2)}/1.0\n`;
      sentimentSection += `| Sentiment | Count | Pct |\n|-----------|-------|-----|\n`;
      const total = topTweets.length;
      sentimentSection += `| Positive | ${stats.positive} | ${Math.round((stats.positive / total) * 100)}% |\n`;
      sentimentSection += `| Negative | ${stats.negative} | ${Math.round((stats.negative / total) * 100)}% |\n`;
      sentimentSection += `| Neutral | ${stats.neutral} | ${Math.round((stats.neutral / total) * 100)}% |\n`;
      if (stats.mixed > 0) {
        sentimentSection += `| Mixed | ${stats.mixed} | ${Math.round((stats.mixed / total) * 100)}% |\n`;
      }
      sentimentSection += "\n";

      // Show tweets with most extreme sentiment
      const positive = enriched.filter(t => t.sentiment?.sentiment === "positive")
        .sort((a, b) => (b.sentiment?.score || 0) - (a.sentiment?.score || 0));
      const negative = enriched.filter(t => t.sentiment?.sentiment === "negative")
        .sort((a, b) => (a.sentiment?.score || 0) - (b.sentiment?.score || 0));

      if (positive.length > 0) {
        sentimentSection += `### Most Positive\n\n`;
        sentimentSection += positive.slice(0, 3).map(formatTweetMarkdown).join("\n\n");
        sentimentSection += "\n\n";
      }
      if (negative.length > 0) {
        sentimentSection += `### Most Negative\n\n`;
        sentimentSection += negative.slice(0, 3).map(formatTweetMarkdown).join("\n\n");
        sentimentSection += "\n\n";
      }
    } catch (e: any) {
      sentimentSection += `## Sentiment Analysis\n\n*Analysis failed: ${e.message}*\n\n`;
    }
  }

  // ---- 4. AI Summary ----
  let aiSummary = "";
  console.error(`  Generating AI summary...`);
  try {
    const tweetContext = topTweets.slice(0, 15)
      .map((t, i) => `[${i + 1}] @${t.username} (${t.metrics.likes}L): ${t.text.slice(0, 280)}`)
      .join("\n");

    const prompt = `Based on these ${topTweets.length} tweets about "${query}", provide:
1. A 2-3 sentence executive summary of the current conversation
2. Key themes (3-5 bullet points)
3. Notable signals or trends
4. Any emerging narratives or sentiment shifts

Be concise and actionable.`;

    const response = await analyzeQuery(prompt, tweetContext, { model: opts.model || "grok-3-mini" });
    aiSummary = response.content;
  } catch (e: any) {
    aiSummary = `*AI summary unavailable: ${e.message}*`;
  }

  // ---- Build report ----
  let report = `# Intelligence Report: ${query}\n\n`;
  report += `**Generated:** ${time}\n`;
  report += `**Tweets analyzed:** ${tweets.length}\n`;
  if (opts.accounts && opts.accounts.length > 0) {
    report += `**Tracked accounts:** ${opts.accounts.join(", ")}\n`;
  }
  report += "\n---\n\n";

  // AI Summary
  report += `## Executive Summary\n\n${aiSummary}\n\n`;

  // Sentiment
  if (sentimentSection) {
    report += sentimentSection;
  }

  // Top tweets
  report += `## Top Tweets (by engagement)\n\n`;
  report += topTweets.slice(0, 10).map(formatTweetMarkdown).join("\n\n");
  report += "\n\n";

  // Account sections
  for (const [username, userTweets] of Object.entries(accountTweets)) {
    if (userTweets.length > 0) {
      report += `## @${username} — Recent Activity\n\n`;
      report += userTweets.slice(0, 5).map(formatTweetMarkdown).join("\n\n");
      report += "\n\n";
    }
  }

  // Metadata
  report += `---\n\n## Report Metadata\n\n`;
  report += `- **Query:** ${query}\n`;
  report += `- **Date:** ${date}\n`;
  report += `- **Tweets scanned:** ${tweets.length}\n`;
  report += `- **Est. cost:** ~$${(tweets.length * 0.005).toFixed(2)} (search) + Grok API\n`;
  report += `- **Generated by:** [xint](https://github.com/0xNyk/xint)\n`;

  return report;
}

// ---------------------------------------------------------------------------
// CLI handler
// ---------------------------------------------------------------------------

export async function cmdReport(args: string[]): Promise<void> {
  const queryParts: string[] = [];
  let accounts: string[] = [];
  let sentiment = false;
  let model: string | undefined;
  let pages: number | undefined;
  let save = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--accounts":
      case "-a": {
        const val = args[++i];
        if (val) accounts = val.split(",").map(a => a.trim());
        break;
      }
      case "--sentiment":
      case "-s":
        sentiment = true;
        break;
      case "--model":
        model = args[++i];
        break;
      case "--pages":
        pages = parseInt(args[++i] || "2");
        break;
      case "--save":
        save = true;
        break;
      case "--help":
      case "-h":
        printReportHelp();
        return;
      default:
        queryParts.push(arg);
    }
    i++;
  }

  const query = queryParts.join(" ");
  if (!query) {
    printReportHelp();
    return;
  }

  const report = await generateReport(query, {
    accounts: accounts.length > 0 ? accounts : undefined,
    sentiment,
    model,
    pages,
    save,
  });

  console.log(report);

  if (save) {
    const slug = query
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)
      .toLowerCase();
    const date = new Date().toISOString().split("T")[0];
    const SKILL_DIR = import.meta.dir;
    const path = join(SKILL_DIR, "..", "data", "exports", `report-${slug}-${date}.md`);
    writeFileSync(path, report);
    console.error(`\nSaved to ${path}`);
  }
}

function printReportHelp(): void {
  console.log(`
Usage: xint report <topic> [options]

Generate an automated intelligence report combining search results,
sentiment analysis, and AI-powered insights.

Options:
  --accounts, -a <list>  Comma-separated accounts to track (e.g., @user1,@user2)
  --sentiment, -s        Include AI sentiment analysis
  --model <name>         Grok model: grok-3, grok-3-mini (default), grok-2
  --pages <N>            Search pages, 1-5 (default: 2)
  --save                 Save report to data/exports/

Examples:
  xint report "AI agents"
  xint report "solana" --sentiment --save
  xint report "react 19" --accounts @reactjs,@dan_abramov --sentiment
  xint report "crypto market" -a @VitalikButerin,@caborek -s --model grok-3
`);
}
