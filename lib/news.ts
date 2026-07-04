import { search, type Tweet } from "./api";

function getArg(args: string[], name: string, fallback?: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] || fallback;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function parseLimit(args: string[]): number {
  const raw = getArg(args, "--limit", "10");
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.floor(n))) : 10;
}

function formatArticleCandidate(tweet: Tweet) {
  const firstUrl = tweet.urls?.[0];
  return {
    id: tweet.id,
    author: tweet.username,
    name: tweet.name,
    created_at: tweet.created_at,
    text: tweet.text,
    url: firstUrl?.url || tweet.tweet_url,
    title: firstUrl?.title || tweet.article?.title || "",
    description: firstUrl?.description || tweet.article?.preview_text || "",
    metrics: tweet.metrics,
    tweet_url: tweet.tweet_url,
  };
}

export async function searchNews(query: string, opts: { limit?: number } = {}) {
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit || 10)));
  const tweets = await search(`${query} has:links -is:retweet`, {
    maxResults: Math.max(10, limit),
    pages: 1,
    sortOrder: "relevancy",
    fieldLevel: "minimal",
  });
  return tweets.filter((tweet) => tweet.urls?.length).slice(0, limit).map(formatArticleCandidate);
}

export async function cmdNews(args: string[]): Promise<void> {
  const json = hasFlag(args, "--json");
  const limit = parseLimit(args);
  const queryParts = args.filter((arg, idx) => {
    if (arg === "--json" || arg === "--markdown") return false;
    if (arg === "--limit") return false;
    if (idx > 0 && args[idx - 1] === "--limit") return false;
    return true;
  });
  const query = queryParts.join(" ").trim();

  if (!query) {
    console.error("usage: xint news <query> [--limit N] [--json]");
    process.exitCode = 2;
    return;
  }

  const articles = await searchNews(query, { limit });

  if (json) {
    console.log(JSON.stringify({ query, articles }, null, 2));
    return;
  }

  for (const article of articles) {
    console.log(`${article.title || article.text.split("\n")[0]}`);
    console.log(`@${article.author} · ${article.tweet_url}`);
    if (article.url) console.log(article.url);
    if (article.description) console.log(article.description);
    console.log("");
  }
}
