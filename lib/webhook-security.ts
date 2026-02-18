const WEBHOOK_ALLOWLIST_ENV = "XINT_WEBHOOK_ALLOWED_HOSTS";

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function normalizeRule(rule: string): string {
  return rule.trim().toLowerCase();
}

function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map(normalizeRule)
    .filter(Boolean);
}

function hostAllowedByRule(hostname: string, rule: string): boolean {
  if (rule.startsWith("*.")) {
    const suffix = rule.slice(2);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  return hostname === rule;
}

export function validateWebhookUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid webhook URL.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Webhook URL must not include credentials.");
  }

  const hostname = parsed.hostname.toLowerCase();
  const protocol = parsed.protocol.toLowerCase();
  const loopback = isLoopbackHost(hostname);

  if (protocol !== "https:" && !(loopback && protocol === "http:")) {
    throw new Error(
      "Webhook URL must use https:// (http:// is only allowed for localhost/127.0.0.1/::1).",
    );
  }

  const allowlist = parseAllowlist(process.env[WEBHOOK_ALLOWLIST_ENV]);
  if (allowlist.length > 0) {
    const allowed = allowlist.some((rule) => hostAllowedByRule(hostname, rule));
    if (!allowed) {
      throw new Error(
        `Webhook host '${hostname}' is not allowed. Set ${WEBHOOK_ALLOWLIST_ENV} to include it.`,
      );
    }
  }

  return parsed.toString();
}

