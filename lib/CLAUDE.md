# xint TypeScript Codebase Guide

## Project Overview

- **Lines**: ~6,835 LOC across 18 modules
- **Runtime**: Bun (TypeScript)
- **Entry**: `xint.ts` (main CLI)

## File Structure

```
lib/
├── api.ts          # X API wrapper (search, profile, thread, tweet)
├── article.ts      # Article fetching via xAI web_search
├── bookmarks.ts    # OAuth bookmark operations
├── cache.ts       # File-based cache (15min TTL)
├── costs.ts       # API cost tracking & budgets
├── engagement.ts  # Likes, following, bookmark writes
├── followers.ts   # Follower tracking with snapshots
├── format.ts      # Output formatters (Telegram, Markdown, CSV, JSONL)
├── grok.ts        # xAI Grok integration (chat, analyze, vision)
├── mcp.ts         # MCP server (STDIO + SSE modes)
├── oauth.ts       # OAuth 2.0 PKCE authentication
├── report.ts      # Intelligence report generation
├── sentiment.ts   # AI sentiment analysis
├── trends.ts      # Trending topics
├── watch.ts       # Real-time monitoring (polling)
└── x_search.ts    # xAI x-search (AI-powered search)
```

## Key Patterns

### Rate Limiting
- 350ms delay between API requests
- Respects `x-rate-limit-reset` headers

### Caching
- Default TTL: 15 minutes
- Quick mode: 1 hour
- Storage: `data/cache/` (JSON files)

### Token Storage
- OAuth tokens: `data/oauth-tokens.json`
- File permissions: chmod 600 (owner only)

### Error Handling
- All API functions throw on error
- Common errors: 401 (auth), 429 (rate limit), 404 (not found)

## Adding Commands

1. Create `lib/newcmd.ts` with command logic
2. Import in `xint.ts`
3. Add case to main switch statement

```typescript
import { cmdNewCmd } from "./lib/newcmd";

case "newcmd":
  await cmdNewCmd(args.slice(1));
  break;
```

## Adding MCP Tools

Edit `lib/mcp.ts` - add to `TOOLS` array and `executeTool()` method:

```typescript
{
  name: "xint_newtool",
  description: "Description",
  inputSchema: {
    type: "object",
    properties: { param: { type: "string" } },
    required: ["param"]
  }
}
```

## Common Tasks

| Task | Location |
|------|----------|
| Add new command | `lib/newcmd.ts` |
| Add MCP tool | `lib/mcp.ts` |
| Modify search | `lib/api.ts` |
| Add Grok feature | `lib/grok.ts` |
| Change output format | `lib/format.ts` |

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `X_BEARER_TOKEN` | Yes | X API v2 |
| `XAI_API_KEY` | No | Grok features |
| `X_CLIENT_ID` | No | OAuth |

## Testing Notes

- No unit tests in current codebase
- Test API calls with real credentials
- Cache operations use temp directories
