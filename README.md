# xint

**X Intelligence CLI** — search, analyze, and engage on X/Twitter from your terminal.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-f9f1e1.svg)](https://bun.sh)

---

xint wraps the X API v2 into a fast, typed CLI. Search tweets, pull threads, track trends, analyze with Grok AI, manage bookmarks/likes — all without leaving the terminal. Built for developers, researchers, and AI agents.

Spiritual successor to [twint](https://github.com/twintproject/twint). Named after **X Int**elligence.

## Quick Start

```bash
# 1. Clone
git clone https://github.com/0xNyk/xint.git
cd xint

# 2. Set your X API bearer token
cp .env.example .env
# Edit .env and add your X_BEARER_TOKEN

# 3. Search
bun run xint.ts search "your topic" --sort likes --limit 10
```

> **Requires [Bun](https://bun.sh)** (TypeScript runtime). Install: `curl -fsSL https://bun.sh/install | bash`
>
> **Requires [X API access](https://developer.x.com)** with prepaid credits (pay-per-use).

## Features

**Search & Discovery** — Full-text search with engagement sorting, time filters, noise removal, pagination, and full-archive access (back to 2006).

**Bookmarks & Likes** — Read your bookmarks/likes, bookmark/unbookmark tweets, like/unlike — all via OAuth 2.0 PKCE.

**Trending Topics** — Fetch trends by location (30+ countries). Falls back to search-based estimation when the trends API is unavailable.

**Grok AI Analysis** — Pipe search results into xAI's Grok for sentiment analysis, theme extraction, and trend summarization.

**Cost Management** — Per-call cost tracking, daily budgets, weekly/monthly reports. Know exactly what you're spending.

**Watchlists** — Monitor accounts, batch-check recent activity, integrate with scheduled jobs.

## Commands

| Command | Description |
|---------|-------------|
| `search <query>` | Search tweets (recent or full archive) |
| `thread <tweet_id>` | Fetch full conversation thread |
| `profile <username>` | Recent tweets from a user |
| `tweet <tweet_id>` | Fetch a single tweet |
| `bookmarks` | List your bookmarked tweets (OAuth) |
| `bookmark <id>` | Bookmark a tweet (OAuth) |
| `unbookmark <id>` | Remove a bookmark (OAuth) |
| `likes` | List your liked tweets (OAuth) |
| `like <id>` | Like a tweet (OAuth) |
| `unlike <id>` | Unlike a tweet (OAuth) |
| `following [user]` | List accounts you follow (OAuth) |
| `trends [location]` | Trending topics by location |
| `analyze <query>` | Analyze with Grok AI |
| `costs [period]` | View API cost tracking |
| `watchlist` | Show/manage watchlist |
| `auth setup` | Set up OAuth 2.0 PKCE auth |
| `auth status` | Check OAuth token status |
| `auth refresh` | Manually refresh tokens |
| `cache clear` | Clear search cache |

**Shortcuts:** `s` (search), `t` (thread), `p` (profile), `bm` (bookmarks), `tr` (trends), `wl` (watchlist)

## Search Options

```
--sort likes|impressions|retweets|recent   Sort order (default: likes)
--since 1h|3h|12h|1d|7d                   Time filter
--until <date>                             End date (full-archive only)
--full                                     Full-archive search (back to 2006)
--min-likes N                              Filter minimum likes
--min-impressions N                        Filter minimum impressions
--pages N                                  Pages to fetch, 1-5 (default: 1)
--limit N                                  Results to display (default: 15)
--quick                                    Quick mode: 1 page, noise filter, 1hr cache
--from <username>                          Shorthand for from:username
--quality                                  Filter low-engagement tweets (min 10 likes)
--no-replies                               Exclude replies
--save                                     Save results to data/exports/
--json                                     Raw JSON output
--markdown                                 Markdown output
```

### Examples

```bash
# Quick pulse check
bun run xint.ts search "AI agents" --quick

# High-engagement tweets from the last hour
bun run xint.ts search "react 19" --since 1h --sort likes --min-likes 50

# Full-archive deep dive
bun run xint.ts search "bitcoin ETF" --full --pages 3 --save

# Search a specific user's posts
bun run xint.ts search "rust" --from laborasaurus

# Profile + thread combo
bun run xint.ts profile elonmusk
bun run xint.ts thread 1234567890
```

## OAuth Setup

Bookmarks, likes, and following require OAuth 2.0 PKCE authentication.

1. Go to the [X Developer Portal](https://developer.x.com) > Your App > Settings
2. Enable **OAuth 2.0** with **Public client** type
3. Add callback URL: `http://127.0.0.1:3333/callback`
4. Set `X_CLIENT_ID` in your `.env`
5. Run the auth flow:

```bash
bun run xint.ts auth setup
# Opens browser for authorization, captures callback automatically

# On a headless server (no browser):
bun run xint.ts auth setup --manual
# Paste the redirect URL after authorizing in your browser
```

Tokens are stored in `data/oauth-tokens.json` (chmod 600) and auto-refresh when expired.

## Grok AI Analysis

Pipe search results into xAI's Grok for AI-powered analysis.

```bash
# Direct question
bun run xint.ts analyze "What are the top AI agent frameworks right now?"

# Analyze search results
bun run xint.ts search "AI agents" --json | bun run xint.ts analyze --pipe "Summarize themes"

# Analyze from file
bun run xint.ts analyze --tweets data/exports/search-results.json

# Use a specific model
bun run xint.ts analyze --model grok-3 "Deep analysis of crypto market sentiment"
```

Requires `XAI_API_KEY` in your `.env`. Models: `grok-3`, `grok-3-mini` (default), `grok-2`.

## Cost Management

xint tracks every API call and its estimated cost.

```bash
bun run xint.ts costs              # Today's spending
bun run xint.ts costs week         # Last 7 days
bun run xint.ts costs month        # Last 30 days
bun run xint.ts costs budget       # Show budget status
bun run xint.ts costs budget set 2 # Set daily limit to $2
```

**X API v2 pay-per-use rates:**
| Resource | Cost |
|----------|------|
| Tweet read (search, bookmarks, likes) | $0.005/tweet |
| Full-archive tweet read | $0.01/tweet |
| Write operations (like, bookmark) | $0.01/action |
| Trends request | $0.10/request |

Quick mode (`--quick`) and caching minimize costs. Budget warnings appear when thresholds are reached.

## Use as an AI Skill

xint works as a skill for AI coding agents.

### Claude Code

```bash
mkdir -p .claude/skills
cd .claude/skills
git clone https://github.com/0xNyk/xint.git
```

Then ask Claude: "Search X for what people are saying about React 19" — it will use `SKILL.md` as instructions.

### OpenClaw

```bash
mkdir -p skills
cd skills
git clone https://github.com/0xNyk/xint.git
```

The `SKILL.md` provides agentic research loop instructions for autonomous X intelligence gathering.

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `X_BEARER_TOKEN` | Yes | X API v2 bearer token |
| `X_CLIENT_ID` | For OAuth | OAuth 2.0 client ID (bookmarks, likes, following) |
| `XAI_API_KEY` | For Grok | xAI API key (analyze command) |

Set in your environment or in `.env` at the project root.

### File Structure

```
xint/
├── xint.ts              CLI entry point
├── lib/
│   ├── api.ts           X API v2 wrapper
│   ├── oauth.ts         OAuth 2.0 PKCE auth
│   ├── bookmarks.ts     Bookmark operations
│   ├── engagement.ts    Likes, following, bookmark write
│   ├── trends.ts        Trending topics
│   ├── grok.ts          xAI Grok integration
│   ├── costs.ts         Cost tracking + budget
│   ├── cache.ts         File-based cache (15min TTL)
│   └── format.ts        Terminal + markdown formatters
├── data/
│   ├── cache/           Auto-managed search cache
│   ├── exports/         Saved research outputs
│   └── watchlist.example.json
├── references/
│   └── x-api.md         X API endpoint reference
├── SKILL.md             AI agent instructions
├── CHANGELOG.md         Version history
└── .env.example         Environment template
```

## Security

- Bearer tokens are read from env vars or `.env` — never hardcoded or printed to stdout
- OAuth tokens are stored with `chmod 600` and use atomic writes
- **AI agent users:** Session transcripts may log HTTP headers including tokens. Use env vars, review session settings, and rotate tokens if exposed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=0xNyk/xint&type=Date)](https://star-history.com/#0xNyk/xint&Date)
