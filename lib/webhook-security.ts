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

// Private / link-local / metadata ranges — webhook deliveries to these are
// SSRF vectors (e.g. cloud metadata at 169.254.169.254) and are blocked
// unless the host is explicitly allowlisted.
function isPrivateOrLinkLocalIp(hostname: string): boolean {
  const v4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 0) return true;
    return false;
  }
  const h = hostname.replace(/^\[|\]$/g, "");
  if (h === "::" || h === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/i.test(h)) return true; // fe80::/10 link-local
  return false;
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
  const explicitlyAllowed =
    allowlist.length > 0 && allowlist.some((rule) => hostAllowedByRule(hostname, rule));

  if (allowlist.length > 0 && !explicitlyAllowed) {
    throw new Error(
      `Webhook host '${hostname}' is not allowed. Set ${WEBHOOK_ALLOWLIST_ENV} to include it.`,
    );
  }

  if (!loopback && !explicitlyAllowed && isPrivateOrLinkLocalIp(hostname)) {
    throw new Error(
      `Webhook host '${hostname}' is in a private/link-local range. ` +
        `Add it to ${WEBHOOK_ALLOWLIST_ENV} explicitly if this is intentional.`,
    );
  }

  return parsed.toString();
}

