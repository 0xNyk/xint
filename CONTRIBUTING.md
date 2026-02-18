# Contributing to xint

Thanks for your interest in contributing!

## Getting Started

1. Fork and clone the repo
2. Configure required environment variables locally (see README)
3. Install [Bun](https://bun.sh) if you haven't already
4. Run `bun run xint.ts --help` to verify everything works

## Making Changes

- Keep changes focused — one feature or fix per PR
- Follow the existing code style (TypeScript, no semicolons in new code is fine, match the file you're editing)
- Test your changes manually with real API calls before submitting
- Don't commit `.env`, `data/oauth-tokens.json`, or `data/cache/` files

## Architecture

```
xint.ts          CLI entry point + arg parsing
lib/api.ts       X API v2 wrapper (bearer token auth)
lib/oauth.ts     OAuth 2.0 PKCE (user-context auth)
lib/bookmarks.ts Bookmark read operations
lib/engagement.ts Like/unlike, following, bookmark write
lib/trends.ts    Trending topics (API + search fallback)
lib/grok.ts      xAI Grok analysis integration
lib/costs.ts     API cost tracking + budget
lib/cache.ts     File-based result cache
lib/format.ts    Output formatters (terminal + markdown)
```

## Reporting Issues

- Include the command you ran and the error output
- Mention your Bun version (`bun --version`)
- Don't include API keys or tokens in issue reports

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
