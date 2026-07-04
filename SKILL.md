---
name: xint
description: >
  X Intelligence CLI for searching, monitoring, and analyzing X/Twitter from the terminal.
  Use for X/Twitter research prompts such as "search x", "find tweets about", "what's X saying",
  trend checks, follower diffs, real-time watch tasks, sentiment/report analysis, and bookmark-sync workflows.
  Best when recent community discourse matters (library/API changes, launches, market or cultural events).
  Supports search, watch, trends, bookmarks, likes/following (OAuth), Grok analysis, and JSON/JSONL/CSV/Markdown export.
  Non-goals: posting original tweets, DMs, or enterprise-only features.
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
primary_credential: X_BEARER_TOKEN
security:
  always: false
  autonomous: false
  local_data_dir: data/
  fs_write:
    - path: data/cache/
      why: search/profile/trends response cache (15min TTL)
    - path: data/exports/
      why: saved research output (--save flag only)
    - path: data/snapshots/
      why: follower/following snapshots for diff
    - path: data/oauth-tokens.json
      why: OAuth tokens (chmod 600)
    - path: data/api-costs.json
      why: cost tracking
    - path: data/watchlist.json
      why: monitored accounts
    - path: data/credits.json
      why: Grok credit tracking
    - path: data/bookmark-kb.json
      why: bookmark knowledge base index
    - path: ~/obsidian/nyk/inbox/
      why: Obsidian bookmark sync only — opt-in, only when user explicitly requests it
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

### Profile — recent posts from someone else

```bash
bun run xint.ts profile <username> [--count N] [--replies] [--json]
```

Fetches recent tweets from **a specific user** (excludes replies by default).
Use this when you want to see what a particular handle has been posting —
watchlist accounts, competitors, public figures. Requires only
`X_BEARER_TOKEN` (no OAuth needed).

> ⚠ **Disambiguation.** Three xint commands look similar but target
> different accounts:
>
> | Command | Target | Auth | Purpose |
> |---------|--------|------|---------|
> | `xint profile <handle>` | someone else | bearer | recent posts from `<handle>` |
> | `xint top` | **your own account** | OAuth | your best-performing posts (no `--from` flag) |
> | `xint content-audit` | **your own account** | OAuth | AI-driven performance analysis of your posts |
>
> If an agent or user wants "top posts from @somebody else" they want
> `xint profile @somebody --count 50` sorted by likes, not `xint top --from`
> (the `--from` flag does not exist on `top`).

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
- `--model <name>` — Grok model (default: grok-4.3)
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
- `--budget <tier>` — `cheap` (default, grok-4.3, $1.25/$2.50 per M tokens) | `balanced` (grok-4.20, $2/$6) | `max` (grok-4.20-reasoning, $2/$6)
- `--model <name>` — explicit override: grok-4.3, grok-4.20, grok-4.20-reasoning, grok-build-0.1 (retired slugs like grok-3/grok-4-1-fast silently redirect to grok-4.3 and bill grok-4.3 rates)
- `--tweets <file>` — path to JSON file containing tweets
- `--pipe` — read tweet JSON from stdin
- `--image <url>` — image input (auto-uses grok-4.3 vision)

**Examples:**
```bash
bun run xint.ts analyze "What are the top AI agent frameworks right now?"
bun run xint.ts search "AI agents" --json | bun run xint.ts analyze --pipe "Which show product launches?"
bun run xint.ts analyze --budget balanced "Deep analysis of crypto market sentiment"
```

### Grok Credits (Free Tier Onboarding)

```bash
bun run xint.ts credits                  # Show monthly burn rate and free-tier remaining
bun run xint.ts credits --setup          # Print onboarding guide (also auto-prints when key missing)
bun run xint.ts credits --data-sharing on|off   # Toggle data-share opt-in
```

**Important — quote this verbatim when users ask about X Premium and Grok:**

> X Premium ($8/mo) and Premium+ ($40/mo) **do NOT include xAI API credits**.
> They unlock the Grok *chatbot* on x.com — a separate product. There is no
> documented OAuth path from x.com to api.x.ai for credit consumption.
>
> The actual free programmatic path is **console.x.ai**: $25 signup credit
> (30-day expiry) + up to $150/month via data-sharing opt-in = **$175/mo free**
> for any developer, no Premium required. Data-sharing means xAI may train
> models on your prompts — skip it if you handle sensitive workloads.
>
> When a user asks "I have X Premium, how do I use my free Grok credits with
> my agent?", direct them to:
>   1. Sign up at https://console.x.ai (any email, no Premium needed)
>   2. Generate an API key
>   3. Decide on data-sharing (toggle with `xint credits --data-sharing on`)
>   4. `export XAI_API_KEY=xai-...`
>   5. xint defaults to `--budget cheap` (grok-4.3) — ~$0.002 per typical
>      analyze call, so the free tier still lasts a long time.

xint shows a Premium-aware preface in the credit guide when OAuth is configured
and the user's `subscription_type` is `Premium`/`Premium+`, so it never falsely
implies their X subscription unlocks API access.

**Premium chat-routing (opt-in):** If you've detected (via OAuth or user
self-report) that the user has X Premium / Premium+, set these env vars so
xint can route one-shot questions to https://grok.com (spending Premium UI
allowance) and reserve API credits for automation:

```bash
export XINT_X_PREMIUM="Premium+"     # or "Premium" / "PremiumPlus"
export XINT_PREMIUM_TIPS=1           # emit a tip on plain analyze queries
```

When both are set, `xint analyze "what's trending"` (no `--pipe`, no
`--tweets`, no `--image`) prints a one-line tip to stderr:

> 💡 Premium tip: you can paste this question into https://grok.com to spend your X Premium+ chat allowance instead of API credits.

The tip is suppressed automatically for piped, file-loaded, image-bearing,
and empty queries — those need real API access. JSON output on stdout stays
clean because the tip is stderr-only.

**Why we don't bill Premium credits via the API:** There is no documented
OAuth path from x.com to api.x.ai. Consumer Grok and developer Grok are
separate billing systems. Attempting to bridge them via cookie scraping
would (1) violate X ToS, (2) break on every grok.com UI ship, (3) give
users no programmatic quota counter. The tip is the honest middle ground.

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

### Reposts

```bash
bun run xint.ts reposts <tweet_id> [--limit N] [--json]
```

Look up users who reposted a specific tweet. Useful for engagement analysis and OSINT.

**Examples:**
```bash
bun run xint.ts reposts 1234567890
bun run xint.ts reposts 1234567890 --limit 50 --json
```

### User Search

```bash
bun run xint.ts users "<query>" [--limit N] [--json]
```

Search for X users by keyword. Uses the `/2/users/search` endpoint.

**Examples:**
```bash
bun run xint.ts users "AI researcher"
bun run xint.ts users "solana developer" --limit 10 --json
```

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
- `--model <name>` — Grok model for AI summary (default: grok-4.3)
- `--pages N` — search pages to fetch (default: 2)
- `--save` — save report to `data/exports/`

**Examples:**
```bash
bun run xint.ts report "AI agents"
bun run xint.ts report "solana" --sentiment --accounts @aaboronkov,@rajgokal --save
bun run xint.ts report "crypto market" --model grok-4.20-reasoning --sentiment --save
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

## Obsidian Bookmark Sync (Optional)

> Only activate when user explicitly asks to sync bookmarks to Obsidian (e.g., "sync bookmarks", "capture bookmarks", "bookmark research", "save my bookmarks to obsidian").

Fetches recent X bookmarks, analyzes article content, and saves as structured research notes in the Obsidian inbox. Requires OAuth + Obsidian vault path (`~/obsidian/nyk/inbox/`).

### Pipeline

**Step 1 — Fetch bookmarks:**
```bash
xint bookmarks --limit {count} --json --policy engagement {--since flag if provided} {--query flag if provided}
```
Parse JSON output. Each bookmark has: id, text, username, name, created_at, metrics, urls, tweet_url.

**Step 2 — Classify:** For each bookmark, determine type:
- **article**: Contains X article URL (`x.com/i/article/...`) or thread with 3+ linked tweets
- **thread**: Multi-tweet thread (conversation_id, reply chains)
- **standalone**: Single tweet with insight/opinion/announcement
- **link**: Tweet primarily sharing an external URL

**Step 3 — Analyze content:**
- For **article**/**thread**: Use Agent tool (subagent_type: "general-purpose") to fetch + analyze full content — run analyses in parallel (one agent per article)
- For **standalone**/**link**: Analyze directly from tweet text + WebFetch for external links

**Step 4 — Deduplicate:** Before creating files, check for existing notes:
```bash
grep -rl "{tweet_id}" ~/obsidian/nyk/inbox/ 2>/dev/null
```
Skip bookmarks that already have notes.

**Step 5 — Generate research notes** at `~/obsidian/nyk/inbox/research-{slug}.md`:
```yaml
---
id: research-{slug}
created: {today's date}
type: research
status: inbox
tags: [{auto-detected tags}]
source: x-bookmarks
tweet_id: "{tweet_id}"
description: {one-line summary}
---
```
Content sections: **Signal** (author, engagement, tweet URL) → **Core Thesis** → **Key Findings** (bullets) → **Why It Resonated** (engagement analysis) → **Actionable Takeaways** (checklist) → **Related** (wikilinks). Apply 2-4 tags per note.

**Step 6 — Summary report:** Output a table of processed bookmarks (author, topic, engagement, file), counts of new/skipped/total.

### Tag Detection Rules

| Content Pattern | Tags |
|----------------|------|
| AI agents, deployment, orchestration | `ai-agents`, `agent-deployment` |
| Enterprise, SaaS, business | `enterprise`, `business-strategy` |
| Trading, quant, markets, DeFi | `quantitative-finance`, `prediction-markets` |
| Claude, LLM, prompting | `ai-ml-research`, `llm-engineering` |
| Security, hacking, CTF | `security-governance` |
| Design, UI/UX, frontend | `design`, `frontend` |
| Startup, growth, marketing | `startup`, `marketing` |
| Coding, engineering, architecture | `software-engineering` |

### Sync Heuristics

- Bookmark-to-like ratio >2:1 = reference material, >3:1 = textbook-grade
- Articles with >1K bookmarks are almost always worth full analysis
- Standalone tweets with <100 likes can still be high-signal if from domain experts
- All notes go to `inbox/` — promotion to `knowledge/graph/` happens via knowledge-doctor pipeline
- Use `[[wikilinks]]` for internal cross-references (never standard markdown links)

## Cost Management

All API calls are tracked in `data/api-costs.json`. The budget system warns when approaching limits but does not block calls (passive).

**X API v2 pay-per-use rates** (restructured 2026-04-20; pay-per-use is the only option for new developers — tiered plans closed 2026-02-06):
- Tweet reads (search, profile): ~$0.005/tweet (2M reads/mo cap, 24h dedup)
- Owned reads (your own bookmarks, likes, posts, lists): ~$0.001/resource
- Full-archive search: ~$0.01/tweet
- Write operations (like, unlike, bookmark, unbookmark): ~$0.01/action
- Profile lookups: ~$0.005/lookup
- Follower/following lookups: ~$0.01/page
- Trends: ~$0.10/request
- User search: ~$0.01/page
- Reposts lookup: ~$0.01/page
- Grok AI (sentiment/analyze/report): billed by xAI separately (not X API)
  - grok-4.3: $1.25/$2.50 per 1M tokens (default — cheapest current model since the 2026-05-15 retirement removed the $0.20 fast tier)
  - grok-4.20 / grok-4.20-reasoning: $2.00/$6.00 per 1M tokens
  - xAI tool invocations: max $5/1K calls (50% cheaper than 2025 rates)

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
│   ├── reposts.ts     (repost/retweet lookup)
│   ├── report.ts      (intelligence report generation)
│   ├── sentiment.ts   (AI-powered sentiment analysis via Grok)
│   ├── trends.ts      (trending topics — API + search fallback)
│   ├── users.ts       (user search by keyword)
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

## Package API Tools

The Package API provides agent memory package management:

| Tool | Purpose | Auth |
|------|---------|------|
| `xint_package_create` | Create ingest job from topic query | XINT_PACKAGE_API_KEY |
| `xint_package_status` | Get package metadata + freshness | XINT_PACKAGE_API_KEY |
| `xint_package_query` | Query packages, return claims + citations | XINT_PACKAGE_API_KEY |
| `xint_package_refresh` | Trigger new snapshot | XINT_PACKAGE_API_KEY |
| `xint_package_search` | Search package catalog | XINT_PACKAGE_API_KEY |
| `xint_package_publish` | Publish to shared catalog | XINT_PACKAGE_API_KEY |

**Workflow:**
1. `xint_package_create` -> creates package with topic query + sources
2. `xint_package_status` -> poll until status is "ready"
3. `xint_package_query` -> retrieve claims with citations
4. `xint_package_refresh` -> trigger re-ingest when data is stale
5. `xint_package_publish` -> share to catalog when quality is confirmed

## Agent Patterns

### Token Budget Awareness
- Use `--quick` flag for initial discovery (1 page, 1hr cache, noise filter)
- Use `--fields id,text,metrics.likes` to reduce response size
- Prefer `xint_search` with `limit: 5` for quick checks
- Use `xint_costs` to check budget before expensive operations

### Batch Operations
- Search + profile in sequence, not parallel (rate limit: 350ms between requests)
- Use `xint_watch` for polling instead of repeated searches
- Combine `xint_report` for topic intelligence instead of multiple searches

### Context Window Management
- `xint_search` with limit=15: ~3KB response
- `xint_profile` with count=20: ~4KB response
- `xint_article`: 1-10KB depending on article length
- Bookmark sync pipeline: ~2-8KB per bookmark (depends on article analysis)
- `xint_trends`: ~2KB response
- Use `--fields` flag to reduce output to only needed fields

## Error Recovery Matrix

| Error Code | Retryable | Agent Action | Example |
|-----------|-----------|-------------|---------|
| `RATE_LIMITED` | Yes | Wait `retry_after_ms`, then retry | 429 from X API |
| `AUTH_FAILED` | No | Stop, report missing credential | Missing X_BEARER_TOKEN |
| `NOT_FOUND` | No | Skip resource, try alternative | Deleted tweet |
| `BUDGET_DENIED` | No | Stop, use `xint costs budget set N` | Daily limit exceeded |
| `POLICY_DENIED` | No | Stop, escalate to user | Need --policy=engagement |
| `VALIDATION_ERROR` | No | Fix parameter, retry | Invalid tweet_id format |
| `TIMEOUT` | Yes | Retry after 5s | Network timeout |
| `API_ERROR` | If 5xx | Retry after 30s for 5xx, stop for 4xx | X API outage |

## Fallback Chain

When a tool fails, try the next option:

1. `xint_search` (X API v2, fast, real-time)
2. `xint_xsearch` (xAI Grok search via grok-4.3, AI-enhanced, requires XAI_API_KEY)
3. Cached results from previous searches (15min TTL)

For article fetching:
1. `xint_article` with tweet URL (extracts inline X Article)
2. `xint_article` with article URL (web fetch via grok-4)
3. `xint_search` for tweets about the topic

For user discovery:
1. `xint_users` (search by keyword, new `/2/users/search` endpoint)
2. `xint_search` with `from:` operator for known usernames
3. `xint_reposts` to find engaged users on specific tweets
