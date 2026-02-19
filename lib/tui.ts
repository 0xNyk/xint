import { join } from "path";
import { createInterface } from "readline/promises";
import { emitKeypressEvents } from "readline";
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
  lastCommand?: string;
  lastStatus?: string;
  lastOutputLines: string[];
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

function normalizeChoice(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) return "";
  const byKey = MENU_OPTIONS.find((option) => option.key === value);
  if (byKey) return byKey.key;
  const byAlias = MENU_OPTIONS.find((option) => option.aliases.includes(value));
  if (byAlias) return byAlias.key;
  return "";
}

function clipText(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width <= 3) return ".".repeat(width);
  return `${value.slice(0, width - 3)}...`;
}

function padText(value: string, width: number): string {
  return clipText(value, width).padEnd(width, " ");
}

function buildLeftPane(activeIndex: number): string[] {
  const lines: string[] = [
    "=== xint interactive ===",
    "Use Up/Down + Enter. Press q to exit.",
    "",
  ];
  MENU_OPTIONS.forEach((option, index) => {
    const isActive = index === activeIndex;
    const pointer = isActive ? "›" : " ";
    const aliases = option.aliases.length > 0 ? ` (${option.aliases.join(", ")})` : "";
    lines.push(`${pointer} ${option.key}) ${option.label}${aliases}`);
    lines.push(`    ${option.hint}`);
  });
  return lines;
}

function buildRightPane(session: SessionState): string[] {
  const lines: string[] = ["=== last run ==="];
  lines.push(`command: ${session.lastCommand ?? "-"}`);
  lines.push(`status: ${session.lastStatus ?? "-"}`);
  lines.push("");
  lines.push("output:");
  if (session.lastOutputLines.length === 0) {
    lines.push("(none yet)");
  } else {
    lines.push(...session.lastOutputLines);
  }
  return lines;
}

function renderInteractiveMenu(activeIndex: number, session: SessionState): void {
  const columns = output.columns ?? 120;
  const rows = output.rows ?? 32;
  const leftWidth = Math.max(42, Math.floor(columns * 0.45));
  const rightWidth = Math.max(24, columns - leftWidth - 3);
  const totalRows = Math.max(14, rows - 1);
  const leftLines = buildLeftPane(activeIndex);
  const rightLines = buildRightPane(session).slice(-totalRows);
  const separator = " | ";

  output.write("\x1b[2J\x1b[H");
  for (let row = 0; row < totalRows; row += 1) {
    const leftRaw = leftLines[row] ?? "";
    const rightRaw = rightLines[row] ?? "";
    const isActive = leftRaw.startsWith("› ");
    const leftText = padText(leftRaw, leftWidth);
    if (isActive) {
      output.write(`\x1b[1;36m${leftText}\x1b[0m${separator}${padText(rightRaw, rightWidth)}\n`);
    } else {
      output.write(`${leftText}${separator}${padText(rightRaw, rightWidth)}\n`);
    }
  }
}

async function selectOption(
  rl: ReturnType<typeof createInterface>,
  session: SessionState,
  activeIndexRef: { value: number },
): Promise<string> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    output.write("\n=== xint interactive ===\n");
    output.write("Type a number or alias.\n");
    MENU_OPTIONS.forEach((option) => {
      const aliases = option.aliases.length > 0 ? ` (${option.aliases.join(", ")})` : "";
      output.write(`${option.key}) ${option.label}${aliases}\n`);
    });
    return normalizeChoice(await rl.question("\nSelect option (number or alias): "));
  }

  emitKeypressEvents(input);
  let activeIndex = activeIndexRef.value;

  return await new Promise<string>((resolve) => {
    const onKeypress = (str: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        resolve("0");
        return;
      }
      if (key.name === "up") {
        activeIndex = (activeIndex - 1 + MENU_OPTIONS.length) % MENU_OPTIONS.length;
        renderInteractiveMenu(activeIndex, session);
        return;
      }
      if (key.name === "down") {
        activeIndex = (activeIndex + 1) % MENU_OPTIONS.length;
        renderInteractiveMenu(activeIndex, session);
        return;
      }
      if (key.name === "return") {
        const selected = MENU_OPTIONS[activeIndex];
        activeIndexRef.value = activeIndex;
        cleanup();
        output.write("\x1b[2J\x1b[H");
        resolve(selected?.key ?? "0");
        return;
      }
      const normalized = normalizeChoice(str);
      if (normalized) {
        activeIndexRef.value = activeIndex;
        cleanup();
        output.write("\x1b[2J\x1b[H");
        resolve(normalized);
        return;
      }
    };

    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
    };

    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
    renderInteractiveMenu(activeIndex, session);
  });
}

function decodeLines(bytes: Uint8Array): string[] {
  if (bytes.length === 0) return [];
  return new TextDecoder()
    .decode(bytes)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

async function runSubcommand(
  args: string[],
  session: SessionState,
  activeIndexRef: { value: number },
): Promise<{ status: string; outputLines: string[] }> {
  const scriptPath = join(import.meta.dir, "..", "xint.ts");
  const proc = Bun.spawn({
    cmd: [process.execPath, scriptPath, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  const spinnerFrames = ["|", "/", "-", "\\"];
  let spinnerIndex = 0;
  const spinner = setInterval(() => {
    session.lastStatus = `running ${spinnerFrames[spinnerIndex % spinnerFrames.length]}`;
    spinnerIndex += 1;
    if (input.isTTY && output.isTTY) {
      renderInteractiveMenu(activeIndexRef.value, session);
    }
  }, 90);

  const stdoutPromise = proc.stdout ? new Response(proc.stdout).arrayBuffer() : Promise.resolve(new ArrayBuffer(0));
  const stderrPromise = proc.stderr ? new Response(proc.stderr).arrayBuffer() : Promise.resolve(new ArrayBuffer(0));

  const [stdoutBuffer, stderrBuffer, exitCode] = await Promise.all([
    stdoutPromise,
    stderrPromise,
    proc.exited,
  ]);
  clearInterval(spinner);

  const stdoutLines = decodeLines(new Uint8Array(stdoutBuffer));
  const stderrLines = decodeLines(new Uint8Array(stderrBuffer)).map((line) => `[stderr] ${line}`);
  const combined = [...stdoutLines, ...stderrLines];
  const capped = combined.slice(-120);
  const status = exitCode === 0 ? "success" : `failed (exit ${exitCode})`;
  return { status, outputLines: capped };
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
  const initialIndex = MENU_OPTIONS.findIndex((option) => option.key === "1");
  const activeIndexRef = { value: initialIndex >= 0 ? initialIndex : 0 };
  const session: SessionState = {
    lastOutputLines: [],
  };
  const rl = createInterface({ input, output });
  try {
    for (;;) {
      const choice = await selectOption(rl, session, activeIndexRef);
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
            session.lastCommand = `xint search ${query}`;
            const result = await runSubcommand(["search", query], session, activeIndexRef);
            session.lastStatus = result.status;
            session.lastOutputLines = result.outputLines;
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
            session.lastCommand = location ? `xint trends ${location}` : "xint trends";
            const result = await runSubcommand(
              location ? ["trends", location] : ["trends"],
              session,
              activeIndexRef,
            );
            session.lastStatus = result.status;
            session.lastOutputLines = result.outputLines;
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
            session.lastCommand = `xint profile ${username}`;
            const result = await runSubcommand(["profile", username], session, activeIndexRef);
            session.lastStatus = result.status;
            session.lastOutputLines = result.outputLines;
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
            session.lastCommand = `xint thread ${tweetRef}`;
            const result = await runSubcommand(["thread", tweetRef], session, activeIndexRef);
            session.lastStatus = result.status;
            session.lastOutputLines = result.outputLines;
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
            session.lastCommand = `xint article ${url}`;
            const result = await runSubcommand(["article", url], session, activeIndexRef);
            session.lastStatus = result.status;
            session.lastOutputLines = result.outputLines;
            break;
          }
          case "6": {
            session.lastCommand = "xint --help";
            const result = await runSubcommand(["--help"], session, activeIndexRef);
            session.lastStatus = result.status;
            session.lastOutputLines = result.outputLines;
            break;
          }
          default:
            console.log("[tui] Unknown option.");
            break;
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[tui] ${message}`);
      }
    }
  } finally {
    rl.close();
  }
}
