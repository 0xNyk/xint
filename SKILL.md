---
name: xint
description: >
  X Intelligence CLI — search, analyze, and engage on X/Twitter from the terminal.
  Use when: (1) user says "x research", "search x for", "search twitter for",
  "what are people saying about", "what's twitter saying", "check x for", "x search",
  "search x", "find tweets about", "monitor x for", "track followers", (2) user is working on 
  something where recent X discourse would provide useful context (new library releases, 
  API changes, product launches, cultural events, industry drama), (3) user wants to find 
  what devs/experts/community thinks about a topic, (4) user needs real-time monitoring ("watch"),
  (5) user wants AI-powered analysis ("analyze", "sentiment", "report").
  Also supports: bookmarks, likes, following (read/write), trending topics, Grok AI analysis,
  and cost tracking. Export as JSON, JSONL (pipeable), CSV, or Markdown.
  Non-goals: Not for posting tweets, not for DMs, not for enterprise features.
  Requires OAuth for user-context operations (bookmarks, likes, following, diff).
credentials:
  - name: X_BEARER_TOKEN
    description: X API v2 bearer token for search, profile, thread, tweet, trends
    required: true
  - name: XAI_API_KEY
    description: xAI API key for Grok analysis, article fetching, sentiment, x-search, collections
    required: false
  - name: XAI_MANAGEMENT_API_KEY
    description: xAI Management API key for collections management
    required: false
  - name: X_CLIENT_ID
    description: X OAuth 2.0 client ID for user-context operations (bookmarks, likes, following, diff)
    required: false
required_env_vars:
  - X_BEARER_TOKEN
requiredEnvVars:
  - X_BEARER_TOKEN
primary_credential: X_BEARER_TOKEN
primaryCredential: X_BEARER_TOKEN
security:
  always: false
  autonomous: false
  local_data_dir: data/
  network_endpoints:
    - https://api.x.com
    - https://x.com
    - https://api.x.ai
---

# xint — X Intelligence CLI

General-purpose agentic research over X/Twitter. Decompose any research question into targeted searches, iteratively refine, follow threads, deep-dive linked content, and synthesize into a sourced briefing.

For X API details (endpoints, operators, response format): read `references/x-api.md`.

## Security Considerations

This skill requires sensitive credentials. Follow these guidelines:

### Credentials
- **X_BEARER_TOKEN**: Required for X API. Treat as a secret - prefer exported environment variables (optional project-local `.env`)
- **XAI_API_KEY**: Optional, needed for AI analysis. Also a secret
- **X_CLIENT_ID**: Optional, needed for OAuth. Less sensitive but don't expose publicly
- **XAI_MANAGEMENT_API_KEY**: Optional, for collections management

### File Writes
- This skill writes to its own `data/` directory: cache, exports, snapshots, OAuth tokens
- OAuth tokens stored with restrictive permissions (chmod 600)
- Review exported data before sharing - may contain sensitive search queries

### Webhooks
- `watch` and `stream` can send data to webhook endpoints
- Remote endpoints must use `https://` (`http://` is accepted only for localhost/loopback)
- Optional host allowlist: `XINT_WEBHOOK_ALLOWED_HOSTS=hooks.example.com,*.internal.example`
- Avoid sending sensitive search queries or token-bearing URLs to third-party destinations

### Runtime Notes
- This file documents usage and safety controls for the CLI only.
- Network listeners are opt-in (`mcp --sse`) and disabled by default
- Webhook delivery is opt-in (`--webhook`) and disabled by default

### Installation
- For Bun: prefer OS package managers over `curl | bash` when possible
- Verify any installer scripts before running

### MCP Server (Optional)
- `bun run xint.ts mcp` starts a local MCP server exposing xint commands as tools
- Default mode is stdio/local integration; no inbound web server unless `--sse` is explicitly enabled
- Respect `--policy read_only|engagement|moderation` and budget guardrails

## CLI Tool

All commands run from the project directory:

```bash
# Set your environment variables
export X_BEARER_TOKEN="your-token"
```

### Search

```bash
bun run xint.ts search "<query>" [options]
```

**Options:**
- `--sort likes|impressions|retweets|recent` — sort order (default: likes)
- `--since 1h|3h|12h|1d|7d` — time filter (default: last 7 days). Also accepts minutes (`30m`) or ISO timestamps.
- `--min-likes N` — filter by minimum likes
- `--min-impressions N` — filter by minimum impressions
- `--pages N` — pages to fetch, 1-5 (default: 1, 100 tweets/page)
- `--limit N` — max results to display (default: 15)
- `--quick` — quick mode: 1 page, max 10 results, auto noise filter, 1hr cache, cost summary
- `--from <username>` — shorthand for `from:username` in query
- `--quality` — filter low-engagement tweets (>=10 likes, post-hoc)
- `--no-replies` — exclude replies
- `--sentiment` — AI-powered per-tweet sentiment analysis (via Grok). Shows positive/negative/neutral/mixed with scores.
- `--save` — save results to `data/exports/`
- `--json` — raw JSON output
- `--jsonl` — one JSON object per line (optimized for Unix pipes: `| jq`, `| tee`)
- `--csv` — CSV output for spreadsheet analysis
- `--markdown` — markdown output for research docs

Auto-adds `-is:retweet` unless query already includes it. All searches display estimated API cost.

**Examples:**
```bash
bun run xint.ts search "AI agents" --sort likes --limit 10
bun run xint.ts search "from:elonmusk" --sort recent
bun run xint.ts search "(opus 4.6 OR claude) trading" --pages 2 --save
bun run xint.ts search "$BTC (revenue OR fees)" --min-likes 5
bun run xint.ts search "AI agents" --quick
bun run xint.ts search "AI agents" --quality --quick
bun run xint.ts search "solana memecoins" --sentiment --limit 20
bun run xint.ts search "startup funding" --csv > funding.csv
bun run xint.ts search "AI" --jsonl | jq 'select(.metrics.likes > 100)'
```

### Profile

```bash
bun run xint.ts profile <username> [--count N] [--replies] [--json]
```

Fetches recent tweets from a specific user (excludes replies by default).

### Thread

```bash
bun run xint.ts thread <tweet_id> [--pages N]
```

Fetches full conversation thread by root tweet ID.

### Single Tweet

```bash
bun run xint.ts tweet <tweet_id> [--json]
```

### Article (Full Content Fetcher)

```bash
bun run xint.ts article <url> [--json] [--full] [--ai <text>]
```

Fetches and extracts full article content from any URL using xAI's web_search tool (Grok reads the page). Returns clean text with title, author, date, and word count. Requires `XAI_API_KEY`.

Also supports X tweet URLs — automatically extracts the linked article from the tweet and fetches it.

**Options:**
- `--json` — structured JSON output (title, content, author, published, wordCount, ttr)
- `--full` — return full article text without truncation (default truncates to ~5000 chars)
- `--model <name>` — Grok model (default: grok-4)
- `--ai <text>` — analyze article with Grok AI (passes content to analyze command)

**Examples:**
```bash
# Fetch article from URL
bun run xint.ts article https://example.com/blog/post

# Auto-extract article from X tweet URL and analyze
bun run xint.ts article "https://x.com/user/status/123456789" --ai "Summarize key takeaways"

# Fetch + analyze with AI
bun run xint.ts article https://techcrunch.com/article --ai "What are the main points?"

# Full content without truncation
bun run xint.ts article https://blog.example.com/deep-dive --full
```

**Agent usage:** When search results include tweets with article links, use `article` to read the full content. Search results now include article titles and descriptions from the X API (shown as `📰` lines), so you can decide which articles are worth a full read. Prioritize articles that:
- Multiple tweets reference
- Come from high-engagement tweets
- Have relevant titles/descriptions from the API metadata

### Bookmarks

```bash
bun run xint.ts bookmarks [options]       # List bookmarked tweets
bun run xint.ts bookmark <tweet_id>       # Bookmark a tweet
bun run xint.ts unbookmark <tweet_id>     # Remove a bookmark
```

**Bookmark list options:**
- `--limit N` — max bookmarks to display (default: 20)
- `--since <dur>` — filter by recency (1h, 1d, 7d, etc.)
- `--query <text>` — client-side text filter
- `--json` — raw JSON output
- `--markdown` — markdown output
- `--save` — save to data/exports/
- `--no-cache` — skip cache

Requires OAuth. Run `auth setup` first.

### Likes

```bash
bun run xint.ts likes [options]           # List your liked tweets
bun run xint.ts like <tweet_id>           # Like a tweet
bun run xint.ts unlike <tweet_id>         # Unlike a tweet
```

**Likes list options:** Same as bookmarks (`--limit`, `--since`, `--query`, `--json`, `--no-cache`).

Requires OAuth with `like.read` and `like.write` scopes.

### Following

```bash
bun run xint.ts following [username] [--limit N] [--json]
```

Lists accounts you (or another user) follow. Defaults to the authenticated user.

Requires OAuth with `follows.read` scope.

### Trends

```bash
bun run xint.ts trends [location] [options]
```

Fetches trending topics. Tries the official X API trends endpoint first; falls back to search-based hashtag frequency estimation if unavailable.

**Options:**
- `[location]` — location name or WOEID number (default: worldwide)
- `--limit N` — number of trends to display (default: 20)
- `--json` — raw JSON output
- `--no-cache` — bypass the 15-minute cache
- `--locations` — list all known location names

**Examples:**
```bash
bun run xint.ts trends                    # Worldwide
bun run xint.ts trends us --limit 10      # US top 10
bun run xint.ts trends japan --json       # Japan, JSON output
bun run xint.ts trends --locations        # List all locations
```

### Analyze (Grok AI)

```bash
bun run xint.ts analyze "<query>"                              # Ask Grok a question
bun run xint.ts analyze --tweets <file>                        # Analyze tweets from JSON file
bun run xint.ts search "topic" --json | bun run xint.ts analyze --pipe  # Pipe search results
```

Uses xAI's Grok API (OpenAI-compatible). Requires `XAI_API_KEY` in env or `.env`.

**Options:**
- `--model <name>` — grok-3, grok-3-mini (default), grok-2
- `--tweets <file>` — path to JSON file containing tweets
- `--pipe` — read tweet JSON from stdin

**Examples:**
```bash
bun run xint.ts analyze "What are the top AI agent frameworks right now?"
bun run xint.ts search "AI agents" --json | bun run xint.ts analyze --pipe "Which show product launches?"
bun run xint.ts analyze --model grok-3 "Deep analysis of crypto market sentiment"
```

## xAI X Search (No Cookies/GraphQL)

For “recent sentiment / what X is saying” without using cookies/GraphQL, use xAI’s hosted `x_search` tool.

Script:

```bash
python3 scripts/xai_x_search_scan.py --help
```

## xAI Collections Knowledge Base (Files + Collections)

Store first-party artifacts (reports, logs) in xAI Collections and semantic-search them later.

Script:

```bash
python3 scripts/xai_collections.py --help
```

Env:
- `XAI_API_KEY` (api.x.ai): file upload + search
- `XAI_MANAGEMENT_API_KEY` (management-api.x.ai): collections management + attaching documents

Notes:
- Never print keys.
- Prefer `--dry-run` when wiring new cron jobs.

### Watch (Real-Time Monitoring)

```bash
bun run xint.ts watch "<query>" [options]
```

Polls a search query on an interval, shows only new tweets. Great for monitoring topics during catalysts, tracking mentions, or feeding live data into downstream tools.

**Options:**
- `--interval <dur>` / `-i` — poll interval: `30s`, `1m`, `5m`, `15m` (default: 5m)
- `--webhook <url>` — POST new tweets as JSON to this URL (`https://` required for remote hosts)
- `--jsonl` — output as JSONL instead of formatted text (for piping to `tee`, `jq`, etc.)
- `--quiet` — suppress per-poll headers (just show tweets)
- `--limit N` — max tweets to show per poll
- `--sort likes|impressions|retweets|recent` — sort order

Press `Ctrl+C` to stop — prints session stats (duration, total polls, new tweets found, total cost).

**Examples:**
```bash
bun run xint.ts watch "solana memecoins" --interval 5m
bun run xint.ts watch "@vitalikbuterin" --interval 1m
bun run xint.ts watch "AI agents" -i 30s --webhook https://hooks.example.com/ingest
bun run xint.ts watch "breaking news" --jsonl | tee -a feed.jsonl
```

**Agent usage:** Use `watch` when you need continuous monitoring of a topic. For one-off checks, use `search` instead. The watch command auto-stops if the daily budget is exceeded.

### Diff (Follower Tracking)

```bash
bun run xint.ts diff <@username> [options]
```

Tracks follower/following changes over time using local snapshots. First run creates a baseline; subsequent runs show who followed/unfollowed since last check.

**Options:**
- `--following` — track who the user follows (instead of their followers)
- `--history` — view all saved snapshots for this user
- `--json` — structured JSON output
- `--pages N` — pages of followers to fetch (default: 5, 1000 per page)

Requires OAuth (`auth setup` first). Snapshots stored in `data/snapshots/`.

**Examples:**
```bash
bun run xint.ts diff @vitalikbuterin          # First run: create snapshot
bun run xint.ts diff @vitalikbuterin          # Later: show changes
bun run xint.ts diff @0xNyk --following       # Track who you follow
bun run xint.ts diff @solana --history        # View snapshot history
```

**Agent usage:** Use `diff` to detect notable follower changes for monitored accounts. Combine with `watch` for comprehensive account monitoring. Run periodically (e.g., daily) to build a history of follower changes.

### Report (Intelligence Reports)

```bash
bun run xint.ts report "<topic>" [options]
```

Generates comprehensive markdown intelligence reports combining search results, optional sentiment analysis, and AI-powered summary via Grok.

**Options:**
- `--sentiment` — include per-tweet sentiment analysis
- `--accounts @user1,@user2` — include per-account activity sections
- `--model <name>` — Grok model for AI summary (default: grok-3-mini)
- `--pages N` — search pages to fetch (default: 2)
- `--save` — save report to `data/exports/`

**Examples:**
```bash
bun run xint.ts report "AI agents"
bun run xint.ts report "solana" --sentiment --accounts @aaboronkov,@rajgokal --save
bun run xint.ts report "crypto market" --model grok-3 --sentiment --save
```

**Agent usage:** Use `report` when the user wants a comprehensive briefing on a topic. This is the highest-level command — it runs search, sentiment, and analysis in one pass and produces a structured markdown report. For quick pulse checks, use `search --quick` instead.

### Costs

```bash
bun run xint.ts costs                     # Today's costs
bun run xint.ts costs week                # Last 7 days
bun run xint.ts costs month               # Last 30 days
bun run xint.ts costs all                 # All time
bun run xint.ts costs budget              # Show budget info
bun run xint.ts costs budget set 2.00     # Set daily limit to $2
bun run xint.ts costs reset               # Reset today's data
```

Tracks per-call API costs with daily aggregates and configurable budget limits.

### Watchlist

```bash
bun run xint.ts watchlist                       # Show all
bun run xint.ts watchlist add <user> [note]     # Add account
bun run xint.ts watchlist remove <user>         # Remove account
bun run xint.ts watchlist check                 # Check recent from all
```

### Auth

```bash
bun run xint.ts auth setup [--manual]    # Set up OAuth 2.0 (PKCE)
bun run xint.ts auth status              # Check token status
bun run xint.ts auth refresh             # Manually refresh tokens
```

Required scopes: `bookmark.read bookmark.write tweet.read users.read like.read like.write follows.read offline.access`

### Cache

```bash
bun run xint.ts cache clear    # Clear all cached results
```

15-minute TTL. Avoids re-fetching identical queries.

## Research Loop (Agentic)

When doing deep research (not just a quick search), follow this loop:

### 1. Decompose the Question into Queries

Turn the research question into 3-5 keyword queries using X search operators:

- **Core query**: Direct keywords for the topic
- **Expert voices**: `from:` specific known experts
- **Pain points**: Keywords like `(broken OR bug OR issue OR migration)`
- **Positive signal**: Keywords like `(shipped OR love OR fast OR benchmark)`
- **Links**: `url:github.com` or `url:` specific domains
- **Noise reduction**: `-is:retweet` (auto-added), add `-is:reply` if needed

### 2. Search and Extract

Run each query via CLI. After each, assess:
- Signal or noise? Adjust operators.
- Key voices worth searching `from:` specifically?
- Threads worth following via `thread` command?
- Linked resources worth deep-diving?

### 3. Follow Threads

When a tweet has high engagement or is a thread starter:
```bash
bun run xint.ts thread <tweet_id>
```

### 4. Deep-Dive Linked Content

Search results now include article titles and descriptions from the X API (shown as `📰` in output). Use these to decide which links are worth a full read, then fetch with `xint article`:

```bash
bun run xint.ts article <url>               # terminal display
bun run xint.ts article <url> --json         # structured output
bun run xint.ts article <url> --full         # no truncation
```

Prioritize links that:
- Multiple tweets reference
- Come from high-engagement tweets
- Have titles/descriptions suggesting depth (not just link aggregators)
- Point to technical resources directly relevant to the question

### 5. Analyze with Grok

For complex research, pipe search results into Grok for synthesis:
```bash
bun run xint.ts search "topic" --json | bun run xint.ts analyze --pipe "Summarize themes and sentiment"
```

### 6. Synthesize

Group findings by theme, not by query:

```
### [Theme/Finding Title]

[1-2 sentence summary]

- @username: "[key quote]" (NL, NI) [Tweet](url)
- @username2: "[another perspective]" (NL, NI) [Tweet](url)

Resources shared:
- [Resource title](url) — [what it is]
```

### 7. Save

Use `--save` flag to save to `data/exports/`.

## Cost Management

All API calls are tracked in `data/api-costs.json`. The budget system warns when approaching limits but does not block calls (passive).

**X API v2 pay-per-use rates:**
- Tweet reads (search, bookmarks, likes, profile): ~$0.005/tweet
- Full-archive search: ~$0.01/tweet
- Write operations (like, unlike, bookmark, unbookmark): ~$0.01/action
- Profile lookups: ~$0.005/lookup
- Follower/following lookups: ~$0.01/page
- Trends: ~$0.10/request
- Grok AI (sentiment/analyze/report): billed by xAI separately (not X API)

Default daily budget: $1.00 (adjustable via `costs budget set <N>`).

## Refinement Heuristics

- **Too much noise?** Add `-is:reply`, use `--sort likes`, narrow keywords
- **Too few results?** Broaden with `OR`, remove restrictive operators
- **Crypto spam?** Add `-$ -airdrop -giveaway -whitelist`
- **Expert takes only?** Use `from:` or `--min-likes 50`
- **Substance over hot takes?** Search with `has:links`

## File Structure

```
xint/
├── SKILL.md           (this file — agent instructions)
├── xint.ts            (CLI entry point)
├── lib/
│   ├── api.ts         (X API wrapper: search, thread, profile, tweet)
│   ├── article.ts     (full article content fetcher via xAI web_search)
│   ├── bookmarks.ts   (bookmark read — OAuth)
│   ├── cache.ts       (file-based cache, 15min TTL)
│   ├── costs.ts       (API cost tracking & budget)
│   ├── engagement.ts  (likes, like/unlike, following, bookmark write — OAuth)
│   ├── followers.ts   (follower/following tracking + snapshot diffs)
│   ├── format.ts      (terminal, markdown, CSV, JSONL formatters)
│   ├── grok.ts        (xAI Grok analysis integration)
│   ├── oauth.ts       (OAuth 2.0 PKCE auth + token refresh)
│   ├── report.ts      (intelligence report generation)
│   ├── sentiment.ts   (AI-powered sentiment analysis via Grok)
│   ├── trends.ts      (trending topics — API + search fallback)
│   └── watch.ts       (real-time monitoring with polling)
├── data/
│   ├── api-costs.json  (cost tracking data)
│   ├── oauth-tokens.json (OAuth tokens — chmod 600)
│   ├── watchlist.json  (accounts to monitor)
│   ├── exports/        (saved research)
│   ├── snapshots/      (follower/following snapshots for diff)
│   └── cache/          (auto-managed)
└── references/
    └── x-api.md        (X API endpoint reference)
```
