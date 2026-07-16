# Security policy

## Supported versions

Security fixes target the current release and `main`. Older releases are not maintained as separate support lines unless a GitHub advisory says otherwise.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/0xNyk/xint/security/advisories/new). If GitHub is unavailable, email `nyk@builderz.dev` with the subject `xint security report`.

Include the affected command or component, reproduction conditions, likely impact, and any suggested mitigation. Remove API keys, OAuth tokens, personal data, and unrelated local paths from logs or screenshots.

Do not open a public issue for an unpatched vulnerability. The maintainer will coordinate validation, remediation, disclosure timing, and reporter credit privately. No response-time guarantee is offered.

## Scope

Reports are especially useful for:

- credential or OAuth token exposure;
- command or argument injection;
- unsafe webhook, MCP, or package API behavior;
- path traversal or unintended local file access;
- incorrect authorization on write actions;
- dependency or release-integrity failures.

Third-party service availability, provider pricing changes, social engineering without a product flaw, and reports containing only automated scanner output are outside the security program unless they demonstrate a concrete xint vulnerability.
