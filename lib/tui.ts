import { join } from "path";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";

type MenuOption = {
  key: string;
  label: string;
  aliases: string[];
  hint: string;
};

type SessionState = {
  lastSearch?: string;
  lastLocation?: string;
  lastUsername?: string;
  lastTweetRef?: string;
  lastArticleUrl?: string;
};

const MENU_OPTIONS: MenuOption[] = [
  { key: "1", label: "Search", aliases: ["search", "s"], hint: "keyword, topic, or boolean query" },
  { key: "2", label: "Trends", aliases: ["trends", "trend", "t"], hint: "location name or blank for global" },
  { key: "3", label: "Profile", aliases: ["profile", "user", "p"], hint: "username (without @)" },
  { key: "4", label: "Thread", aliases: ["thread", "th"], hint: "tweet id or tweet url" },
  { key: "5", label: "Article", aliases: ["article", "a"], hint: "article url or tweet url" },
  { key: "6", label: "Help", aliases: ["help", "h", "?"], hint: "show full CLI help" },
  { key: "0", label: "Exit", aliases: ["exit", "quit", "q"], hint: "close interactive mode" },
];

function printMenu(): void {
  console.log("\n=== xint interactive ===");
  for (const option of MENU_OPTIONS) {
    const aliases = option.aliases.length > 0 ? ` (${option.aliases.join(", ")})` : "";
    console.log(`${option.key}) ${option.label}${aliases}`);
    console.log(`   - ${option.hint}`);
  }
}

function normalizeChoice(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) return "";
  const byKey = MENU_OPTIONS.find((option) => option.key === value);
  if (byKey) return byKey.key;
  const byAlias = MENU_OPTIONS.find((option) => option.aliases.includes(value));
  if (byAlias) return byAlias.key;
  return "";
}

function runSubcommand(args: string[]): void {
  const scriptPath = join(import.meta.dir, "..", "xint.ts");
  const proc = Bun.spawnSync({
    cmd: [process.execPath, scriptPath, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.stdout.length > 0) {
    process.stdout.write(proc.stdout);
  }
  if (proc.stderr.length > 0) {
    process.stderr.write(proc.stderr);
  }
  if (proc.exitCode !== 0) {
    console.error(`\n[tui] command failed with exit code ${proc.exitCode}`);
  }
}

function requireInput(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

function promptWithDefault(value: string, previous?: string): string {
  const trimmed = value.trim();
  if (trimmed) return trimmed;
  return previous ?? "";
}

export async function cmdTui(): Promise<void> {
  const session: SessionState = {};
  const rl = createInterface({ input, output });
  try {
    for (;;) {
      printMenu();
      const choice = normalizeChoice(await rl.question("\nSelect option (number or alias): "));
      if (choice === "0") {
        console.log("Exiting xint interactive mode.");
        break;
      }
      if (!choice) {
        console.log("[tui] Unknown option. Use a number (0-6) or alias like 'search' / 'help'.");
        continue;
      }

      try {
        switch (choice) {
          case "1": {
            const query = requireInput(
              promptWithDefault(
                await rl.question(
                  `Search query${session.lastSearch ? ` [${session.lastSearch}]` : ""}: `,
                ),
                session.lastSearch,
              ),
              "Query",
            );
            session.lastSearch = query;
            runSubcommand(["search", query]);
            break;
          }
          case "2": {
            const location = promptWithDefault(
              await rl.question(
                `Location (blank for worldwide)${session.lastLocation ? ` [${session.lastLocation}]` : ""}: `,
              ),
              session.lastLocation,
            );
            session.lastLocation = location;
            runSubcommand(location ? ["trends", location] : ["trends"]);
            break;
          }
          case "3": {
            const username = requireInput(
              promptWithDefault(
                await rl.question(
                  `Username (@optional)${session.lastUsername ? ` [${session.lastUsername}]` : ""}: `,
                ),
                session.lastUsername,
              ),
              "Username",
            ).replace(/^@/, "");
            session.lastUsername = username;
            runSubcommand(["profile", username]);
            break;
          }
          case "4": {
            const tweetRef = requireInput(
              promptWithDefault(
                await rl.question(
                  `Tweet ID or URL${session.lastTweetRef ? ` [${session.lastTweetRef}]` : ""}: `,
                ),
                session.lastTweetRef,
              ),
              "Tweet ID/URL",
            );
            session.lastTweetRef = tweetRef;
            runSubcommand(["thread", tweetRef]);
            break;
          }
          case "5": {
            const url = requireInput(
              promptWithDefault(
                await rl.question(
                  `Article URL or Tweet URL${session.lastArticleUrl ? ` [${session.lastArticleUrl}]` : ""}: `,
                ),
                session.lastArticleUrl,
              ),
              "Article URL",
            );
            session.lastArticleUrl = url;
            runSubcommand(["article", url]);
            break;
          }
          case "6":
            runSubcommand(["--help"]);
            break;
          default:
            console.log("[tui] Unknown option.");
            break;
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[tui] ${message}`);
      } finally {
        await rl.question("\nPress Enter to return to menu...");
      }
    }
  } finally {
    rl.close();
  }
}
