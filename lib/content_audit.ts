import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { loadTokens, getValidToken } from "./oauth";
import { getUserTimeline, type TweetWithEngagement } from "./timeline";
import { grokChat } from "./grok";
import { bold, cyan, yellow, dim } from "./format";

const SKILL_DIR = import.meta.dir;
const EXPORTS_DIR = join(SKILL_DIR, "..", "data", "exports");

function ensureExportsDir(): void {
  if (!existsSync(EXPORTS_DIR)) mkdirSync(EXPORTS_DIR, { recursive: true });
}

function formatTweetsForAudit(tweets: TweetWithEngagement[]): string {
  return tweets.map((t, i) => {
    const pct = (t.engagement_rate * 100).toFixed(2);
    const text = t.text.replace(/https:\/\/t\.co\/\S+/g, "").trim();
    return `[${i + 1}] (${pct}% eng, ${t.metrics.impressions} imp, ${t.metrics.likes} likes)\n${text}`;
  }).join("\n\n");
}

export async function cmdContentAudit(args: string[]): Promise<void> {
  let since = "30d";
  let save = false;
  let pages = 5;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--since":
        since = args[++i] || "30d";
        break;
      case "--save":
        save = true;
        break;
      case "--pages":
        pages = Math.min(parseInt(args[++i] || "5"), 10);
        break;
      case "--help":
      case "-h":
        printHelp();
        return;
      default:
        break;
    }
    i++;
  }

  let token: string;
  try {
    token = await getValidToken();
  } catch (e: any) {
    console.error("OAuth required. Run 'xint auth setup' first.");
    console.error(`Error: ${e.message}`);
    process.exit(1);
    return;
  }

  const tokens = loadTokens();
  if (!tokens?.user_id) {
    console.error("Could not determine user ID. Re-run 'xint auth setup'.");
    process.exit(1);
    return;
  }

  console.error(`Fetching your tweets (since ${since})...`);

  const tweets = await getUserTimeline(tokens.user_id, token, {
    since,
    pages,
    exclude: ["replies", "retweets"],
  });

  if (tweets.length < 5) {
    console.error("Not enough tweets for a content audit (need at least 5).");
    return;
  }

  console.error(`Analyzing ${tweets.length} tweets...`);

  // Sort by engagement rate
  const sorted = [...tweets].sort((a, b) => b.engagement_rate - a.engagement_rate);
  const top10 = sorted.slice(0, 10);
  const bottom10 = sorted.slice(-10);

  const topContext = formatTweetsForAudit(top10);
  const bottomContext = formatTweetsForAudit(bottom10);

  const prompt = `Analyze these tweets from my account. The first group are my highest-engagement tweets, the second group are my lowest. What content themes/formats drive the most engagement? What should I post more of? Less of? What hooks work best? Be specific and actionable.`;

  console.error("Sending to Grok for analysis...");

  const response = await grokChat(
    [
      {
        role: "system",
        content: "You are a social media strategist analyzing tweet performance data. Provide specific, actionable recommendations based on the engagement metrics.",
      },
      {
        role: "user",
        content: `${prompt}\n\n--- TOP PERFORMERS ---\n${topContext}\n\n--- LOWEST PERFORMERS ---\n${bottomContext}`,
      },
    ],
    { maxTokens: 2048 },
  );

  console.log();
  console.log(bold("Content Audit") + dim(` (${tweets.length} tweets, since ${since})`) + "\n");
  console.log(response.content);
  console.log();
  console.log(dim(`Model: ${response.model} | Tokens: ${response.usage.total_tokens}`));

  if (save) {
    ensureExportsDir();
    const date = new Date().toISOString().slice(0, 10);
    const path = join(EXPORTS_DIR, `content-audit-${date}.md`);
    let md = `# Content Audit — ${date}\n\n`;
    md += `Tweets analyzed: ${tweets.length} (since ${since})\n\n`;
    md += response.content;
    md += `\n\n---\n\nModel: ${response.model} | Tokens: ${response.usage.total_tokens}\n`;
    writeFileSync(path, md);
    console.error(`\nSaved to ${path}`);
  }
}

function printHelp(): void {
  console.log(`
Usage: xint content-audit [options]

AI-powered analysis of your tweet content performance using Grok.
Identifies what works, what doesn't, and actionable recommendations.

Options:
  --since <dur>    Time period (default: 30d)
  --pages <N>      Pages of tweets to fetch (default: 5, max 10)
  --save           Save audit to data/exports/content-audit-{date}.md

Requires: OAuth + XAI_API_KEY

Examples:
  xint content-audit                 # Audit last 30 days
  xint content-audit --since 90d     # Audit last 90 days
  xint content-audit --save          # Save to file
`);
}
