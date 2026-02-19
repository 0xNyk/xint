import { join } from "path";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";

function printMenu(): void {
  console.log("\n=== xint tui ===");
  console.log("1) Search");
  console.log("2) Trends");
  console.log("3) Profile");
  console.log("4) Thread");
  console.log("5) Article");
  console.log("6) Help");
  console.log("0) Exit");
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

export async function cmdTui(): Promise<void> {
  const rl = createInterface({ input, output });
  try {
    for (;;) {
      printMenu();
      const choice = (await rl.question("Select option: ")).trim();
      if (choice === "0") {
        console.log("Exiting xint tui.");
        break;
      }

      try {
        switch (choice) {
          case "1": {
            const query = requireInput(await rl.question("Search query: "), "Query");
            runSubcommand(["search", query]);
            break;
          }
          case "2": {
            const location = (await rl.question("Location (blank for worldwide): ")).trim();
            runSubcommand(location ? ["trends", location] : ["trends"]);
            break;
          }
          case "3": {
            const username = requireInput(await rl.question("Username (@optional): "), "Username")
              .replace(/^@/, "");
            runSubcommand(["profile", username]);
            break;
          }
          case "4": {
            const tweetId = requireInput(await rl.question("Tweet ID or URL: "), "Tweet ID/URL");
            runSubcommand(["thread", tweetId]);
            break;
          }
          case "5": {
            const url = requireInput(await rl.question("Article URL: "), "Article URL");
            runSubcommand(["article", url]);
            break;
          }
          case "6":
            runSubcommand(["--help"]);
            break;
          default:
            console.log("Unknown option.");
            break;
        }
      } catch (error: any) {
        console.error(`[tui] ${error.message || String(error)}`);
      }
    }
  } finally {
    rl.close();
  }
}
