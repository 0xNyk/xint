# xint

<p align="center">
  <img src="assets/hero.png" alt="xint — X Intelligence from your terminal" width="800">
</p>

<p align="center">
  <strong>X Intelligence CLI & AI Agent Skill</strong> — search, monitor, analyze, and engage on X/Twitter from your terminal or through AI agents.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Runtime-Bun-f9f1e1.svg" alt="Runtime: Bun"></a>
</p>

---

xint wraps the X API v2 into a fast, typed CLI built for **AI agents** and **developers**. Search tweets, monitor topics in real-time, track follower changes, analyze sentiment with Grok AI, manage bookmarks/likes — all without leaving the terminal.

Designed as a **skill** for AI coding agents (Claude Code, OpenClaw, etc.) — agents use `SKILL.md` to autonomously run X intelligence operations. Also works standalone for researchers, OSINT practitioners, and power users.

Spiritual successor to [twint](https://github.com/twintproject/twint) (15k+ stars, archived 2023). Named after **X Int**elligence.

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

| Feature | Description |
|---------|-------------|
| **Search & Discovery** | Full-text search with engagement sorting, time filters, noise removal, full-archive (back to 2006) |
| **Real-Time Monitoring** | `watch` command polls on interval, shows only new tweets, supports webhooks |
| **Follower Tracking** | `diff` command snapshots followers/following, computes changes over time |
| **Sentiment Analysis** | `--sentiment` flag enriches results with AI-powered per-tweet sentiment via Grok |
| **Intelligence Reports** | `report` command generates markdown briefings with search + sentiment + AI summary |
| **Bookmarks & Likes** | Read/write bookmarks and likes via OAuth 2.0 PKCE |
| **Trending Topics** | Fetch trends by location (30+ countries), API + search fallback |
| **Grok AI Analysis** | Pipe results into xAI's Grok for theme extraction, trend summarization |
| **Cost Management** | Per-call tracking, daily budgets, weekly/monthly reports |
| **Structured Export** | JSON, JSONL (pipeable), CSV (spreadsheets), Markdown output formats |
| **Watchlists** | Monitor accounts, batch-check recent activity |

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `search <query>` | `s` | Search tweets (recent or full archive) |
| `watch <query>` | `w` | Real-time monitoring with polling |
| `diff <@user>` | — | Track follower/following changes |
| `report <topic>` | — | Generate intelligence report |
| `thread <tweet_id>` | `t` | Fetch full conversation thread |
| `profile <username>` | `p` | Recent tweets from a user |
| `tweet <tweet_id>` | — | Fetch a single tweet |
| `bookmarks` | `bm` | List your bookmarked tweets (OAuth) |
| `bookmark <id>` | — | Bookmark a tweet (OAuth) |
| `unbookmark <id>` | — | Remove a bookmark (OAuth) |
| `likes` | — | List your liked tweets (OAuth) |
| `like <id>` | — | Like a tweet (OAuth) |
| `unlike <id>` | — | Unlike a tweet (OAuth) |
| `following [user]` | — | List accounts you follow (OAuth) |
| `trends [location]` | `tr` | Trending topics by location |
| `analyze <query>` | `ask` | Analyze with Grok AI |
| `costs [period]` | — | View API cost tracking |
| `watchlist` | `wl` | Show/manage watchlist |
| `auth setup` | — | Set up OAuth 2.0 PKCE auth |
| `auth status` | — | Check OAuth token status |
| `auth refresh` | — | Manually refresh tokens |
| `cache clear` | — | Clear search cache |

## Search

```bash
# Quick pulse check
bun run xint.ts search "AI agents" --quick

# High-engagement tweets from the last hour
bun run xint.ts search "react 19" --since 1h --sort likes --min-likes 50

# Full-archive deep dive
bun run xint.ts search "bitcoin ETF" --full --pages 3 --save

# With AI sentiment analysis
bun run xint.ts search "solana memecoins" --sentiment --limit 20

# Export as CSV for spreadsheets
bun run xint.ts search "startup funding" --csv > funding.csv

# JSONL for Unix pipelines
bun run xint.ts search "AI" --jsonl | jq 'select(.metrics.likes > 100)'
```

### Search Options

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
--sentiment                                AI sentiment analysis per tweet (via Grok)
--no-replies                               Exclude replies
--save                                     Save results to data/exports/
--json                                     Raw JSON output
--jsonl                                    JSONL (one tweet per line, pipeable)
--csv                                      CSV output (spreadsheet-friendly)
--markdown                                 Markdown output
```

## Real-Time Monitoring

Monitor X in real-time. Polls a search query on interval, shows only new tweets.

```bash
# Watch a topic every 5 minutes
bun run xint.ts watch "solana memecoins" --interval 5m

# Watch a specific user, check every minute
bun run xint.ts watch "@vitalikbuterin" --interval 1m

# Pipe to webhook (Slack, Discord, etc.)
bun run xint.ts watch "AI agents" -i 30s --webhook https://hooks.slack.com/...

# JSONL output for log aggregation
bun run xint.ts watch "breaking news" --jsonl | tee -a feed.jsonl
```

Press `Ctrl+C` to stop — shows session stats (duration, tweets found, cost).

## Follower Tracking

Track who followed/unfollowed over time with local snapshots.

```bash
# First run: creates a snapshot
bun run xint.ts diff @vitalikbuterin

# Later: shows who followed/unfollowed since last snapshot
bun run xint.ts diff @vitalikbuterin

# Track following changes instead
bun run xint.ts diff @0xNyk --following

# View snapshot history
bun run xint.ts diff @solana --history
```

Requires OAuth setup (`auth setup` first). Snapshots stored locally in `data/snapshots/`.

## Intelligence Reports

Generate comprehensive markdown reports combining search, sentiment, and AI analysis.

```bash
# Basic report
bun run xint.ts report "AI agents"

# With sentiment analysis and tracked accounts
bun run xint.ts report "solana" --sentiment --accounts @aaboronkov,@rajgokal --save

# Use a stronger model for deeper analysis
bun run xint.ts report "crypto market" --model grok-3 --sentiment --save
```

Reports include: executive summary, sentiment breakdown, top tweets, per-account activity, and metadata.

## OAuth Setup

Bookmarks, likes, following, and follower tracking require OAuth 2.0 PKCE authentication.

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
```

Tokens stored in `data/oauth-tokens.json` (chmod 600) and auto-refresh when expired.

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

## Use as an AI Agent Skill

xint is designed as a **skill** for AI agents. The `SKILL.md` file provides structured instructions that agents use to autonomously run X intelligence operations.

### Claude Code

```bash
# Add xint as a skill
mkdir -p .claude/skills
cd .claude/skills
git clone https://github.com/0xNyk/xint.git
```

Then ask Claude: *"Search X for what people are saying about React 19"* — it reads `SKILL.md` and runs the right commands.

### OpenClaw

```bash
# Add to your skills directory
mkdir -p skills
cd skills
git clone https://github.com/0xNyk/xint.git
```

The `SKILL.md` provides agentic research loop instructions — agents decompose topics, search iteratively, follow threads, and synthesize findings.

### Agent Capabilities

When used as a skill, AI agents can:
- **Search & filter** — find relevant tweets with engagement thresholds
- **Monitor topics** — set up `watch` for real-time alerting
- **Track accounts** — use `diff` to detect follower changes
- **Analyze sentiment** — gauge public opinion on any topic
- **Generate reports** — produce intelligence briefings on demand
- **Export structured data** — pipe JSONL/CSV into other tools
- **Manage costs** — check budget before making expensive calls

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `X_BEARER_TOKEN` | Yes | X API v2 bearer token |
| `X_CLIENT_ID` | For OAuth | OAuth 2.0 client ID (bookmarks, likes, following, diff) |
| `XAI_API_KEY` | For Grok | xAI API key (analyze, sentiment, report) |

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
│   ├── watch.ts         Real-time monitoring
│   ├── followers.ts     Follower tracking + diffs
│   ├── sentiment.ts     AI sentiment analysis
│   ├── report.ts        Intelligence report generation
│   ├── trends.ts        Trending topics
│   ├── grok.ts          xAI Grok integration
│   ├── costs.ts         Cost tracking + budget
│   ├── cache.ts         File-based cache (15min TTL)
│   └── format.ts        Terminal, markdown, CSV, JSONL formatters
├── data/
│   ├── cache/           Auto-managed search cache
│   ├── exports/         Saved research outputs
│   ├── snapshots/       Follower/following snapshots
│   └── watchlist.example.json
├── assets/
│   └── hero.png         README hero image
├── references/
│   └── x-api.md         X API endpoint reference
├── SKILL.md             AI agent instructions
├── CHANGELOG.md         Version history
└── .env.example         Environment template
```

## Security

- Bearer tokens are read from env vars or `.env` — never hardcoded or printed to stdout
- OAuth tokens are stored with `chmod 600` and use atomic writes
- Follower snapshots are stored locally and never transmitted
- **AI agent users:** Session transcripts may log HTTP headers including tokens. Use env vars, review session settings, and rotate tokens if exposed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=0xNyk/xint&type=Date)](https://star-history.com/#0xNyk/xint&Date)
