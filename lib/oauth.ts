/**
 * OAuth 2.0 PKCE authentication for X API v2.
 *
 * Supports:
 * - One-time auth setup with PKCE flow (localhost callback or --manual paste)
 * - Token storage with auto-refresh
 * - Scopes: bookmark/like/follows/list/block/mute read+write, tweet.read/write, users.read, offline.access
 */

import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { createHash, randomBytes } from "crypto";
import * as readline from "readline";

const SKILL_DIR = join(import.meta.dir, "..");
const TOKENS_PATH = join(SKILL_DIR, "data", "oauth-tokens.json");
const DATA_DIR = join(SKILL_DIR, "data");

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const USERS_ME_URL = "https://api.x.com/2/users/me";
const REDIRECT_URI = "http://127.0.0.1:3333/callback";
const SCOPES =
  "bookmark.read bookmark.write like.read like.write follows.read follows.write list.read list.write block.read block.write mute.read mute.write tweet.read tweet.write users.read offline.access";

// Token expiry buffer — refresh 60s before actual expiration
const EXPIRY_BUFFER_MS = 60_000;

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix ms
  user_id: string;
  username: string;
  scope: string;
  created_at: string;
  refreshed_at: string;
}

// --- PKCE Helpers ---

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

export function generateCodeChallenge(verifier: string): string {
  const hash = createHash("sha256").update(verifier).digest();
  return base64url(hash);
}

export function generateState(): string {
  return randomBytes(16).toString("hex");
}

// --- Token Storage ---

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadTokens(): OAuthTokens | null {
  if (!existsSync(TOKENS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKENS_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function saveTokens(tokens: OAuthTokens): void {
  ensureDataDir();
  // Atomic write: write to tmp file then rename
  const tmpPath = TOKENS_PATH + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(tokens, null, 2));
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, TOKENS_PATH);
}

// --- Client ID ---

function getClientId(): string {
  if (process.env.X_CLIENT_ID) return process.env.X_CLIENT_ID;

  // Try .env in project directory
  try {
    const envFile = readFileSync(
      join(SKILL_DIR, ".env"),
      "utf-8"
    );
    const match = envFile.match(/X_CLIENT_ID=["']?([^"'\n]+)/);
    if (match) return match[1];
  } catch {}

  throw new Error(
    "X_CLIENT_ID not found. Set it in your environment or in .env"
  );
}

// --- Token Exchange ---

async function exchangeCode(
  code: string,
  codeVerifier: string,
  clientId: string
): Promise<{ access_token: string; refresh_token: string; expires_in: number; scope: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json();
}

async function fetchUserMe(accessToken: string): Promise<{ id: string; username: string }> {
  const res = await fetch(USERS_ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch user info (${res.status}): ${text}`);
  }

  const data = await res.json();
  return { id: data.data.id, username: data.data.username };
}

// --- Refresh ---

export async function refreshTokens(tokens?: OAuthTokens | null): Promise<OAuthTokens> {
  tokens = tokens || loadTokens();
  if (!tokens) {
    throw new Error("No tokens found. Run 'auth setup' first.");
  }

  const clientId = getClientId();

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: clientId,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Token refresh failed (${res.status}): ${text}\n` +
      "You may need to re-run 'auth setup' if the refresh token expired."
    );
  }

  const data = await res.json();
  const now = new Date();

  const updated: OAuthTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token, // X rotates refresh tokens
    expires_at: now.getTime() + data.expires_in * 1000,
    user_id: tokens.user_id,
    username: tokens.username,
    scope: data.scope || tokens.scope,
    created_at: tokens.created_at,
    refreshed_at: now.toISOString(),
  };

  saveTokens(updated);
  return updated;
}

// --- Get Valid Token (auto-refresh) ---

export async function getValidToken(): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) {
    throw new Error(
      "No OAuth tokens found. Run 'auth setup' first.\n" +
      "Usage: xint auth setup [--manual]"
    );
  }

  // Check expiration with buffer
  if (Date.now() >= tokens.expires_at - EXPIRY_BUFFER_MS) {
    console.error("OAuth token expired, refreshing...");
    const refreshed = await refreshTokens(tokens);
    console.error(`Token refreshed for @${refreshed.username}`);
    return refreshed.access_token;
  }

  return tokens.access_token;
}

// --- Auth Setup ---

function buildAuthorizeUrl(clientId: string, codeChallenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function authSetup(manual: boolean = false): Promise<void> {
  const clientId = getClientId();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl(clientId, codeChallenge, state);

  console.error("\n=== X API OAuth 2.0 Setup (PKCE) ===\n");
  console.error("1. Open this URL in your browser:\n");
  console.error(authorizeUrl);
  console.error("\n2. Authorize the app, then:");

  let code: string;

  if (manual) {
    // Manual mode: user pastes the redirect URL
    console.error("   Paste the full redirect URL here:\n");
    const redirectUrl = await prompt("Redirect URL> ");

    const url = new URL(redirectUrl);
    const returnedState = url.searchParams.get("state");
    code = url.searchParams.get("code") || "";

    if (returnedState !== state) {
      throw new Error("State mismatch — possible CSRF attack. Aborting.");
    }
    if (!code) {
      const error = url.searchParams.get("error");
      const desc = url.searchParams.get("error_description");
      throw new Error(`Authorization failed: ${error} — ${desc}`);
    }
  } else {
    // Localhost callback mode
    console.error("   The browser will redirect to localhost:3333\n");

    code = await waitForCallback(state);
  }

  // Exchange code for tokens
  console.error("\nExchanging authorization code for tokens...");
  const tokenData = await exchangeCode(code, codeVerifier, clientId);

  // Fetch user info
  console.error("Fetching user info...");
  const user = await fetchUserMe(tokenData.access_token);

  const now = new Date();
  const tokens: OAuthTokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: now.getTime() + tokenData.expires_in * 1000,
    user_id: user.id,
    username: user.username,
    scope: tokenData.scope,
    created_at: now.toISOString(),
    refreshed_at: now.toISOString(),
  };

  saveTokens(tokens);

  console.error(`\nAuthenticated as @${user.username} (ID: ${user.id})`);
  console.error(`Token expires in ${Math.round(tokenData.expires_in / 60)} minutes`);
  console.error(`Refresh token valid for ~6 months`);
  console.error(`Tokens saved to ${TOKENS_PATH}`);
}

// --- Localhost Callback Server ---

async function waitForCallback(expectedState: string): Promise<string> {
  const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.stop();
      reject(new Error("Callback timeout (5 minutes). Try again with --manual flag."));
    }, TIMEOUT_MS);

    const server = Bun.serve({
      port: 3333,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);

        if (url.pathname !== "/callback") {
          return new Response("Not found", { status: 404 });
        }

        const returnedState = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        clearTimeout(timeout);

        // Schedule server shutdown after response
        setTimeout(() => server.stop(), 100);

        if (error) {
          const desc = url.searchParams.get("error_description") || error;
          reject(new Error(`Authorization denied: ${desc}`));
          return new Response(
            `<html><body><h2>Authorization Failed</h2><p>${desc}</p><p>You can close this tab.</p></body></html>`,
            { headers: { "Content-Type": "text/html" } }
          );
        }

        if (returnedState !== expectedState) {
          reject(new Error("State mismatch — possible CSRF attack."));
          return new Response(
            "<html><body><h2>Error: State Mismatch</h2><p>Possible CSRF attack. Please try again.</p></body></html>",
            { headers: { "Content-Type": "text/html" } }
          );
        }

        if (!code) {
          reject(new Error("No authorization code received."));
          return new Response(
            "<html><body><h2>Error</h2><p>No authorization code received.</p></body></html>",
            { headers: { "Content-Type": "text/html" } }
          );
        }

        resolve(code);
        return new Response(
          "<html><body><h2>Authorization Successful!</h2><p>You can close this tab and return to the terminal.</p></body></html>",
          { headers: { "Content-Type": "text/html" } }
        );
      },
    });

    console.error(`Waiting for callback on http://127.0.0.1:3333/callback ...`);
    console.error(`(timeout in 5 minutes — use Ctrl+C or --manual to abort)\n`);
  });
}

// --- Auth Status ---

export function authStatus(): void {
  const tokens = loadTokens();

  if (!tokens) {
    console.log("❌ No OAuth tokens found.");
    console.log("Run: xint auth setup [--manual]");
    return;
  }

  const expiresIn = tokens.expires_at - Date.now();
  const expiresStr = expiresIn > 0
    ? `${Math.round(expiresIn / 60_000)} minutes`
    : "EXPIRED";

  console.log(`✅ Authenticated as @${tokens.username} (ID: ${tokens.user_id})`);
  console.log(`   Scopes: ${tokens.scope}`);
  console.log(`   Access token: ${expiresStr}`);
  console.log(`   Created: ${tokens.created_at}`);
  console.log(`   Last refresh: ${tokens.refreshed_at}`);
}

// --- Auth Refresh (manual) ---

export async function authRefresh(): Promise<void> {
  const tokens = loadTokens();
  if (!tokens) {
    console.error("No tokens found. Run 'auth setup' first.");
    process.exit(1);
  }

  console.error("Refreshing tokens...");
  const refreshed = await refreshTokens(tokens);
  const expiresIn = Math.round((refreshed.expires_at - Date.now()) / 60_000);
  console.log(`✅ Token refreshed for @${refreshed.username}`);
  console.log(`   New token expires in ${expiresIn} minutes`);
}
