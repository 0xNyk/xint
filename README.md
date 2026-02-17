<!-- markdownlint-disable MD041 -->
<p align="center">
  <img src="assets/hero.png" alt="xint — X Intelligence from your terminal" width="800">
</p>

<p align="center">
  <strong>X Intelligence CLI</strong> — search, monitor, analyze, and engage on X/Twitter from your terminal.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Runtime-Bun-f9f1e1.svg" alt="Bun"></a>
  <a href="https://github.com/0xNyk/xint/releases"><img src="https://img.shields.io/github/v/release/0xNyk/xint?display_name=tag" alt="Release"></a>
  <a href="https://github.com/0xNyk/xint/stargazers"><img src="https://img.shields.io/github/stars/0xNyk/xint" alt="Stars"></a>
  <a href="https://twitter.com/intent/tweet?text=Check+out+xint:+X+Intelligence+CLI+for+AI+agents+%F0%9F%90%A5%0Ahttps://github.com/0xNyk/xint"><img src="https://img.shields.io/twitter/url?label=Tweet&url=https%3A%2F%2Fgithub.com%2F0xNyk%2Fxint" alt="Tweet"></a>
</p>

---

> **Search X like a pro.** Full-text search, real-time monitoring, follower tracking, AI sentiment analysis, and structured export — all from CLI.

## Why xint?

- **For AI Agents** — designed as a [skill](#use-as-an-ai-agent-skill) for Claude Code, OpenClaw, and other coding agents
- **For Researchers** — OSINT, market intelligence, trend tracking without leaving the terminal
- **For Developers** — JSONL/CSV export, Unix pipeline integration, MCP server for AI agent tools
- **Fast** — built on Bun, typed TypeScript, smart caching

Spiritual successor to [twint](https://github.com/twintproject/twint) (archived 2023).

## Install

```bash
git clone https://github.com/0xNyk/xint.git
cd xint
cp .env.example .env
```

> **Requires:** [Bun](https://bun.sh) · [X API access](https://developer.x.com) (prepaid credits)

## Quick Reference

| Task | Command |
|------|---------|
| Search | `xint search "AI agents"` |
| Monitor | `xint watch "solana" -i 5m` |
| Stream | `xint stream` |
| Profile | `xint profile @elonmusk` |
| Thread | `xint thread 123456789` |
| Followers | `xint diff @username` |
| Bookmarks | `xint bookmarks` |
| Lists | `xint lists` |
| Blocks | `xint blocks` |
| Mutes | `xint mutes` |
| Follow | `xint follow @username` |
| Media | `xint media <tweet_id>` |
| Trends | `xint trends` |
| AI Analyze | `xint analyze "best AI frameworks?"` |
| Report | `xint report "crypto"` |
| Article | `xint article <url> --ai "summarize"` |
| Capabilities | `xint capabilities --json` |

### Shorthands

```bash
xint s "query"    # search
xint w "query"    # watch  
xint p @user     # profile
xint tr           # trends
xint bm           # bookmarks
```

## Setup

### 1. X API Key

Copy `.env.example` to `.env`:

```bash
X_BEARER_TOKEN=your_bearer_token_here
```

Get your bearer token from [developer.x.com](https://developer.x.com) → Your Apps → App Settings.

### 2. Optional: xAI for AI Features

For `analyze`, `report --sentiment`, and `article --ai`:

```bash
XAI_API_KEY=your_xai_key_here
```

### 3. Optional: OAuth for Write Access

For bookmarks, likes, lists, blocks/mutes, and follower tracking:

```bash
X_CLIENT_ID=your_oauth_client_id
```

Run `xint auth setup` to complete OAuth flow.

## Agent-Native Capabilities Manifest

`xint` now ships a machine-readable manifest for agent runtime allowlists and tool routing:

```bash
# Pretty JSON
xint capabilities

# Compact JSON for machine ingestion
xint capabilities --compact
```

## Search

```bash
# Quick pulse
xint search "AI agents" --quick

# High-engagement from last hour
xint search "react 19" --since 1h --sort likes --min-likes 50

# Full-archive deep dive
xint search "bitcoin ETF" --full --pages 3

# With sentiment
xint search "solana" --sentiment

# Export
xint search "startups" --csv > data.csv
xint search "AI" --jsonl | jq '.text'
```

### Options

| Flag | Description |
|------|-------------|
| `--sort` | `likes` · `impressions` · `retweets` · `recent` |
| `--since` | `1h` · `3h` · `12h` · `1d` · `7d` |
| `--full` | Search full archive (back to 2006) |
| `--min-likes N` | Filter by engagement |
| `--pages N` | Pages to fetch (1-5) |
| `--sentiment` | Add AI sentiment per tweet |
| `--quick` | Fast mode with caching |

## Watch (Real-Time)

```bash
# Monitor topic every 5 minutes
xint watch "solana" --interval 5m

# Watch user
xint watch "@vitalikbuterin" -i 1m

# Webhook to Slack
xint watch "breaking" -i 30s --webhook https://hooks.slack.com/...
```

Press `Ctrl+C` — shows session stats.

## Stream (Official Filtered Stream)

```bash
# List current stream rules
xint stream-rules

# Add a filtered-stream rule
xint stream-rules add "from:elonmusk -is:retweet" --tag elon

# Connect to stream
xint stream

# JSONL output + stop after 25 events
xint stream --jsonl --max-events 25
```

## Follower Tracking

```bash
# First run: creates snapshot
xint diff @vitalikbuterin

# Second run: shows changes
xint diff @vitalikbuterin

# Track following
xint diff @username --following
```

Requires OAuth (`xint auth setup`).

## Lists (OAuth)

```bash
# List your owned lists
xint lists

# Create a private list
xint lists create "AI Researchers" --description "High-signal accounts" --private

# Add/remove members
xint lists members add <list_id> @username
xint lists members remove <list_id> @username
```

## Blocks & Mutes (OAuth)

```bash
# List blocked/muted users
xint blocks
xint mutes

# Add/remove
xint blocks add @username
xint blocks remove @username
xint mutes add @username
xint mutes remove @username
```

## Follow Actions (OAuth)

```bash
xint follow @username
xint unfollow @username
```

## Media Download

```bash
# Download media from a tweet ID
xint media 1900100012345678901

# Download media from a tweet URL
xint media https://x.com/user/status/1900100012345678901

# Custom output directory + JSON summary
xint media 1900100012345678901 --dir ./downloads --json

# Download only first video/gif
xint media 1900100012345678901 --video-only --max-items 1

# Download only photos
xint media 1900100012345678901 --photos-only

# Custom filename template
xint media 1900100012345678901 --name-template "{username}-{created_at}-{index}"
```

## Intelligence Reports

```bash
# Generate report
xint report "AI agents" --save

# With sentiment + specific accounts
xint report "crypto" --sentiment --accounts @aaboronkov,@solana
```

Reports include: summary, sentiment breakdown, top tweets, account activity.

## Article Analysis

```bash
# Fetch article
xint article "https://example.com"

# Fetch + AI summary
xint article "https://example.com" --ai "Key takeaways?"

# From X tweet
xint article "https://x.com/user/status/123" --ai "Summarize"
```

Uses xAI's `grok-4` model.

## Use as AI Agent Skill

Designed for AI coding agents. Add as a skill:

```bash
# Claude Code
mkdir -p .claude/skills && cd .claude/skills
git clone https://github.com/0xNyk/xint.git

# OpenClaw
mkdir -p skills && cd skills
git clone https://github.com/0xNyk/xint.git
```

Then just ask: *"Search X for what people say about React 19"* — the agent reads `SKILL.md` and runs the right command.

### MCP Server

```bash
xint mcp
```

Runs an MCP server AI agents can connect to.

## Cost

| Operation | Cost |
|-----------|------|
| Tweet read | $0.005/tweet |
| Full-archive | $0.01/tweet |
| Write action | $0.01/action |

```bash
xint costs           # Today's spend
xint costs week      # Last 7 days
xint costs budget    # Show/set limits
```

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `X_BEARER_TOKEN` | Yes | X API v2 bearer token |
| `XAI_API_KEY` | No | xAI key for analyze/report |
| `X_CLIENT_ID` | No | OAuth for bookmarks/likes/lists/blocks/mutes |

## File Structure

```
xint/
├── xint.ts              # CLI entry
├── lib/                 # Core modules
│   ├── api.ts          # X API wrapper
│   ├── oauth.ts        # OAuth 2.0 PKCE
│   ├── grok.ts         # xAI integration
│   ├── sentiment.ts    # AI sentiment
│   ├── watch.ts        # Real-time monitoring
│   └── format.ts       # Output formatters
├── data/
│   ├── cache/          # Search cache (15min TTL)
│   ├── exports/        # Saved results
│   └── snapshots/      # Follower snapshots
├── SKILL.md            # AI agent instructions
└── .env.example        # Template
```

## Security

- Tokens from env vars — never hardcoded
- OAuth tokens stored with `chmod 600`
- Webhooks: use trusted endpoints only
- Review agent session logs in untrusted environments

See [SECURITY.md](docs/security.md) for full details.

## Contributing

Open source! See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) · [0xNyk](https://github.com/0xNyk)

---

<p align="center">
  <a href="https://star-history.com/#0xNyk/xint&Date">
    <img src="https://api.star-history.com/svg?repos=0xNyk/xint&type=Date" alt="Star History" width="400">
  </a>
</p>
