# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — Forecast + user LRU (2026-05-16)
- **`xint costs forecast`** — projects end-of-month spend from current MTD burn rate (or 7-day trailing average when MTD < 3 days). Shows top-3 expensive operations with share-of-spend percentages and a confidence note. `--json` for machine-readable output.
- **Per-process user-record LRU** — `lookupUserByUsername()` caches user resolutions across calls within the same process. Wired into `api.profile()`. A `report` command that iterates 10 accounts now pays for 10 user lookups; a second pass within the same MCP session pays for 0. Pass `{refresh: true}` to bypass.

### Tracked (no behavior change)
- **`stream-rules clear`** now tracks the cost of both the list AND delete API calls instead of just the delete. The X API requires us to fetch IDs before deletion (no "delete all" endpoint), so 2 calls are unavoidable; we just stop under-reporting them.

### Added — Cost preview + MCP exposure (2026-05-16)
- **`--dry-run` flag** on `search` and `diff` — prints an estimated cost preview, cache-hit prediction, and endpoint info, then exits 0 without making any API call. Lets agents and users see what something will cost before paying. Dry-run output goes to stdout so it's machine-parseable.
- **`xint_credits` MCP tool** — exposes Grok free-tier telemetry via MCP. Returns signup-credit remaining, monthly burn, by-feature breakdown. Pass `{setup: true}` for the Premium-vs-API onboarding guidance.
- **`budget` parameter on `xint_analyze` MCP tool** — agents can pass `budget: "cheap"|"balanced"|"max"` to route through the same model-selection logic as the CLI without knowing model names.

### Fixed
- **Field-profile recalibration (2026-05-16)** — Initial `MINIMAL_FIELDS` dropped `entities` and `conversation_id`, silently losing URLs/hashtags/mentions/note_tweet expansion from `search` results because `parseTweets` reads them on every call. Recalibrated: MINIMAL now includes entities + conversation_id (display-essential), STANDARD adds connection_status (for relationship-aware commands), EXTENDED adds article + note_tweet + subscription_type. `thread` root fetch and `getTweet` now use EXTENDED_FIELDS so single-tweet lookups get the full picture (marginal cost is zero per the X API pricing model).
- **Followers cost rate corrected** — `lib/costs.ts` had `followers` at `per_call: 0.01` (flat), but the X API charges per user returned. Changed to `per_tweet: 0.01` so `trackCost` and the new dry-run preview both report the actual cost ($0.01 × users), not a flat $0.01. A 3000-follower diff now correctly previews at $30 instead of $0.01.

### Added — X API efficiency pass (2026-05-16)
- **Field profiles (`MINIMAL_FIELDS` / `STANDARD_FIELDS` / `EXTENDED_FIELDS`)** — `lib/api.ts` now exports three field profiles. `FIELDS` is now an alias for `MINIMAL_FIELDS` so existing call sites get the cheap default automatically. Search accepts `fieldLevel?: "minimal" | "standard" | "extended"` and a `--full-fields` CLI flag for when extended data (article, note_tweet, Premium badges, connection_status) is actually needed downstream. Cuts payload size ~50% on most tweet reads.
- **Followers snapshot cache (24h TTL)** — `lib/followers.ts` reuses the most recent snapshot when it's <24h old. A 5000-follower diff costs ~$50 fresh; a same-day repeat now costs $0. Pass `--fresh` to bypass.
- **Watch seed-window narrowing** — `lib/watch.ts` first-poll seed default cut from 1h to 10m. For a hot query that's $0.10-0.30 less per `watch` startup. `--seed-window` is the new canonical flag name (alias for `--since`).
- **Archive search confirmation gate** — `--full` / `--full-archive` now requires explicit `--confirm` and prints an estimated max-cost preview. Prevents accidental 2x-cost archive searches.

### Added — Grok credit-aware agent mode (2026-05)
- **`credits` command** — Grok free-tier telemetry. Tracks monthly burn against the xAI console.x.ai free tier ($25 signup + $150/mo data-share). Subcommands: `--setup` prints the onboarding guide, `--data-sharing on|off` toggles the bonus opt-in. Auto-runs when `analyze` is called without `XAI_API_KEY` (exits 0 so agents can read the guide).
- **`--budget` flag on `analyze`** — Routes to the cheapest sufficient Grok model. `cheap` (default, grok-4-1-fast), `balanced` (grok-4.3), `max` (grok-4.20-reasoning). Image inputs auto-route to grok-4.3 (vision-capable).
- **`cost_in_usd_ticks` tracking** — When xAI returns the new authoritative cost field in `usage`, we record that value instead of the local pricing estimate. Falls back to estimate for older keys.
- **Premium-aware credit guide** — When OAuth is configured and the user has X Premium/Premium+, the guide explicitly acknowledges this and clarifies that Premium unlocks the Grok chatbot on x.com, not API access.
- **Premium chat-routing tip** — For one-shot human questions (no pipe, no file, no image), Premium users can be tipped to paste the query into https://grok.com to spend their Premium chat allowance instead of API credits. Two opt-ins: `XINT_X_PREMIUM=Premium|Premium+|PremiumPlus` declares status (no API call needed); `XINT_PREMIUM_TIPS=1` enables the tip on `analyze` runs. Tip prints to stderr before the call so it doesn't pollute JSON output.
- **SKILL.md credit guide section** — Verbatim quote block agents can use to onboard users to the free tier without falsely implying X Premium unlocks the API.

### Added
- **`reposts` command** — Look up who reposted a tweet (`GET /2/tweets/:id/retweeted_by`). Supports `--limit`, `--json` output.
- **`users` command** — Search users by keyword (`GET /2/users/search`). Supports `--limit`, `--json` output.
- **`completions` command** — Shell completions for bash, zsh, and fish.
- **`connection_status` field** — Profile and diff output now shows follow/block/mute relationship status.
- **`subscription_type` field** — Profile output now shows Premium/verified badge.
- **`--vision` flag** on `x-search` — Enables `enable_image_understanding` for image analysis during search.
- **`--exclude-domains` / `--allow-domains` flags** on `x-search` — Domain filtering via xAI search tools.
- **Inline citations** — `x-search` and report output now includes source citations from xAI Responses API.
- **403 tier handling** — Graceful error messages when blocks/follows endpoints are restricted by API tier.

### Changed — Grok credit-aware agent mode (2026-05)
- **Grok model pricing table refreshed** — Added `grok-4.3` ($1.25/$2.50, 1M ctx) as the new flagship; added `grok-4.20`, `grok-4.20-reasoning`, `grok-4.20-non-reasoning`, `grok-4-1-fast-non-reasoning`. Retired-but-redirected models (`grok-4`, `grok-3*`, `grok-2*`, `grok-code-fast-1`, `grok-4.20-beta`) kept in the table for pricing lookup when xAI auto-redirects after 2026-05-15.
- **Vision default switched to `grok-4.3`** — `grok-2-vision` retires 2026-05-15 (xAI auto-redirects to `grok-4.3`). We update the default explicitly so behavior is predictable.
- **`--budget cheap` is the new agent default** — `grok-4-1-fast` selected unless `--model` or `--budget balanced|max` is passed. Image inputs override to `grok-4.3` automatically.
- **402 error hint** — Payment-required errors now point to `xint credits` and console.x.ai instead of a generic "out of credits" message.

### Changed
- **Default Grok model** — Switched from `grok-3-mini` to `grok-4-1-fast` across analyze, report, sentiment, and MCP tools ($0.20/$0.50 per 1M tokens — better price/performance).
- **xAI cost rates reduced** — Updated cost tracking to reflect ~50% price drop on xAI tool invocations (grok_chat, grok_analyze, xai_x_search, xai_article).
- **MCP tool descriptions** — Updated model references in all MCP tool schemas.
- **SKILL.md** — Updated model defaults, cost table, fallback chain, added new commands.
- **README.md** — Added reposts/users commands, updated model reference, removed duplicate TUI section.

## [3.1.0] (2026-02-15) — Agent Intelligence Update

Major feature release focused on real-time intelligence, social graph tracking, AI-powered sentiment, and structured export formats. Designed to make xint the most capable X intelligence skill for AI agents.

### ✨ Added
- **`watch` command** — Real-time monitoring. Polls a search query on interval, shows only new tweets. Supports webhook POST (Slack, Discord, etc.), JSONL output for piping, graceful shutdown with session stats. Auto-handles rate limits.
- **`diff` command** — Follower/following tracking with local snapshots. Shows who followed/unfollowed since last check. Supports `--following` for tracking who you follow, `--history` to view all snapshots, `--json` for structured output.
- **`report` command** — Automated intelligence reports combining search + Grok AI analysis + optional sentiment. Generates markdown with executive summary, top tweets, per-account activity, and metadata. `--save` writes to `data/exports/`.
- **`--sentiment` flag** — AI-powered per-tweet sentiment analysis on search results via Grok. Shows positive/negative/neutral/mixed with scores (-1.0 to 1.0) and aggregate stats. Uses batched Grok calls with structured JSON parsing.
- **`--csv` flag** — CSV output for spreadsheet analysis. Proper escaping, header row, all tweet fields.
- **`--jsonl` flag** — One JSON object per line. Optimized for Unix pipelines: `xint search "topic" --jsonl | jq 'select(.metrics.likes > 100)'`
- **`data/snapshots/` directory** — Local storage for follower/following snapshots used by `diff` command.

### 🔧 Changed
- **README rewritten** — Hero image, agent-first positioning, feature table, all new commands documented, "Use as an AI Agent Skill" section expanded.
- **Commands table expanded** — 25 commands total (was 21), with shortcuts for `watch` (`w`), `diff` (also `followers`).
- **Usage text updated** — All new commands and flags documented in `--help`.
- **Cost tracking** — Added `followers` and `following_list` cost rates.

---

## [3.0.0] (2026-02-15) — xint

**Rebranded as xint (X Intelligence).** Open-sourced under MIT license at [github.com/0xNyk/xint](https://github.com/0xNyk/xint).

### Added
- **OAuth 2.0 PKCE authentication** — `auth setup`, `auth status`, `auth refresh` commands for user-context operations
- **Bookmarks** — `bookmarks`, `bookmark`, `unbookmark` commands (read + write)
- **Likes** — `likes`, `like`, `unlike` commands (read + write)
- **Following** — `following [username]` to list accounts you follow
- **Trending topics** — `trends [location]` with 30+ countries, API + search fallback
- **Grok AI analysis** — `analyze` command powered by xAI (grok-3, grok-3-mini, grok-2)
- **Cost management** — per-call tracking, daily budgets, weekly/monthly reports
- **Full-archive search** — `--full` flag for searching back to 2006
- **`package.json`**, **`tsconfig.json`**, and environment template file — proper project scaffolding
- **`CONTRIBUTING.md`** — contribution guide

### Changed
- **Renamed** `x-search.ts` to `xint.ts`, `x-research` to `xint` throughout
- **Generalized environment configuration** — removed machine-specific assumptions; reads config from project root
- **Save location** — `--save` now writes to `data/exports/` (was `data/exports/`)
- **Community-ready README** — badges, command table, OAuth guide, Grok docs, cost reference

### Removed
- Hardcoded machine-specific filesystem paths removed
- Personal usernames and server-specific references

---

## [2.3.0] (2026-02-09)

### 🔒 Security
- **Purged all stale tier/subscription references** across 6 files (13 instances of "Basic tier", "current tier", "enterprise-only" etc.) — LLM hallucination fix
- **Security section in README** — Documents bearer token exposure risk when running inside AI coding agents with session logging

### 🐛 Fixed
- **Tweet truncation bug** — `tweet` and `thread` commands now show full tweet text instead of cutting off at 200 characters. Search results still truncate for readability. (h/t @sergeykarayev)

### ✨ Added
- **Full-archive search** (`/2/tweets/search/all`) is available on pay-per-use — not enterprise-only as LLMs commonly claim
- **Updated rate limits** — old per-15-min caps replaced by spending limits in Developer Console
- **Clarified 7-day limit** — is a skill limitation (using recent search endpoint), not an API restriction
- **Query length limits** — 512 chars (recent), 1024 (full-archive), 4096 (enterprise)
- **Per-resource cost breakdown** — $0.005/post read, $0.010/user lookup, $0.010/post create
- **24-hour deduplication** docs, xAI credit bonus tiers, usage monitoring endpoint

---

## [2.2.0] (2026-02-08)

### ✨ Added
- **`--quick` mode** — Smarter, cheaper searches. Single page, auto noise filtering (`-is:retweet -is:reply`), 1hr cache TTL. Designed for fast pulse checks.
- **`--from <username>`** — Shorthand for `from:username` queries. `search "topic" --from username` instead of typing the full operator.
- **`--quality` flag** — Filters out low-engagement tweets (≥10 likes). Applied post-fetch since `min_faves` operator isn't available via the API.
- **Cost display on all searches** — Every search now shows estimated API cost: `📊 N tweets read · est. cost ~$X`

### 🔧 Changed
- README cleaned up — removed duplicate cost section, added Quick Mode and Cost docs
- Cache supports variable TTL (1hr in quick mode, 15min default)

---

## [2.1.0] (2026-02-08)

### ✨ Added
- **`--since` time filter** — search only recent tweets: `--since 1h`, `--since 3h`, `--since 30m`, `--since 1d`
  - Accepts shorthand (`1h`, `30m`, `2d`) or ISO 8601 timestamps
  - Great for monitoring during catalysts or checking what just dropped
- Minutes support (`30m`, `15m`) in addition to hours and days
- Cache keys now include time filter to prevent stale results across different time ranges

---

## [2.0.0] (2026-02-08)

### ✨ Added
- **`x-search.ts` CLI** — Bun script wrapping the X API. No more inline curl/python one-liners.
  - `search` — query with auto noise filtering, engagement sorting, pagination
  - `profile` — recent tweets from any user
  - `thread` — full conversation thread by tweet ID
  - `tweet` — single tweet lookup
  - `watchlist` — manage accounts to monitor, batch-check recent activity
  - `cache clear` — manage result cache
- **`lib/api.ts`** — Typed X API wrapper with search, thread, profile, tweet lookup, engagement filtering, deduplication
- **`lib/cache.ts`** — File-based cache with 15-minute TTL. Avoids re-fetching identical queries.
- **`lib/format.ts`** — Output formatters for Telegram (mobile-friendly) and markdown (research docs)
- **Watchlist system** — `data/watchlist.json` for monitoring accounts. Useful for heartbeat integration.
- **Auto noise filtering** — `-is:retweet` added by default unless already in query
- **Engagement sorting** — `--sort likes|impressions|retweets|recent`
- **Post-hoc filtering** — `--min-likes N` and `--min-impressions N` (since X API doesn't support these as search operators)
- **Save to file** — `--save` flag auto-saves research to `data/exports/`
- **Multiple output formats** — `--json` for raw data, `--markdown` for research docs, default for Telegram

### 🔧 Changed
- **SKILL.md** rewritten to reference CLI tooling. Research loop instructions preserved and updated.
- **README.md** expanded with full install, setup, usage, and API cost documentation.

### How it compares to v1
- v1 was a prompt-only skill — Claude assembled raw curl commands with inline Python parsers each time
- v2 wraps everything in typed Bun scripts — faster execution, cleaner output, fewer context tokens burned on boilerplate
- Same agentic research loop, same X API, just better tooling underneath

---

## [1.0.0] (2026-02-08)

### ✨ Added
- Initial release
- SKILL.md with agentic research loop (decompose → search → refine → follow threads → deep-dive → synthesize)
- `references/x-api.md` with full X API endpoint reference
- Search operators, pagination, thread following, linked content deep-diving
