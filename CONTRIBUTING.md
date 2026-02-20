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
- Don't commit local secret/config files or generated runtime data artifacts

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

## Branch Protection

`main` should enforce:
- required status checks
- at least 1 approving review
- stale review dismissal on new commits
- conversation resolution before merge
- linear history
- no force pushes or deletions

Automation script:

```bash
cd xint
./scripts/apply-branch-protection.sh --dry-run
./scripts/apply-branch-protection.sh --apply
```

Scope:
- `0xNyk/xint`: `CI / checks`, `Capability Contract / parity`
- `0xNyk/xint-rs`: `CI / checks`
- `0xNyk/xint-cloud`: `ci / checks`

Repository rulesets (hard guardrails):

```bash
cd xint
./scripts/apply-repo-rulesets.sh --dry-run
./scripts/apply-repo-rulesets.sh --apply
```

Ruleset name:
- `Main Branch Guardrails`

Code owners:
- `.github/CODEOWNERS` defines required owners for all paths.
- Branch protection and rulesets enforce code-owner reviews.

Guardrail drift audit:

```bash
cd xint
./scripts/audit-guardrails.sh
```

Optional strict merge-queue assertion (if your GitHub tier exposes merge-queue rulesets):

```bash
REQUIRE_MERGE_QUEUE=true ./scripts/audit-guardrails.sh
```

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
