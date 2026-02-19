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

type Theme = {
  accent: string;
  border: string;
  muted: string;
  reset: string;
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

const THEMES: Record<string, Theme> = {
  minimal: { accent: "\x1b[1m", border: "", muted: "", reset: "\x1b[0m" },
  classic: { accent: "\x1b[1;36m", border: "\x1b[2m", muted: "\x1b[2m", reset: "\x1b[0m" },
  neon: { accent: "\x1b[1;95m", border: "\x1b[38;5;45m", muted: "\x1b[38;5;244m", reset: "\x1b[0m" },
};

const HELP_LINES = [
  "Hotkeys",
  "  Up/Down: Move selection",
  "  Enter: Run selected command",
  "  /: Command palette",
  "  ?: Toggle help",
  "  q or Esc: Exit",
];

function activeTheme(): Theme {
  const requested = (process.env.XINT_TUI_THEME || "classic").toLowerCase();
  return THEMES[requested] ?? THEMES.classic;
}

function normalizeChoice(raw: string | undefined | null): string {
  if (typeof raw !== "string") return "";
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

function scoreOption(option: MenuOption, query: string): number {
  const q = query.toLowerCase();
  if (!q) return 0;
  let score = 0;
  if (option.key === q) score += 100;
  if (option.label.toLowerCase() === q) score += 90;
  if (option.aliases.includes(q)) score += 80;
  if (option.label.toLowerCase().startsWith(q)) score += 70;
  if (option.aliases.some((alias) => alias.startsWith(q))) score += 60;
  if (option.label.toLowerCase().includes(q)) score += 40;
  if (option.hint.toLowerCase().includes(q)) score += 20;
  return score;
}

function matchPalette(query: string): MenuOption | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  let best: MenuOption | null = null;
  let bestScore = 0;
  for (const option of MENU_OPTIONS) {
    const score = scoreOption(option, trimmed);
    if (score > bestScore) {
      bestScore = score;
      best = option;
    }
  }
  return bestScore > 0 ? best : null;
}

function buildLeftPane(activeIndex: number): string[] {
  const lines: string[] = ["=== xint interactive ===", "", "Menu", ""]; 
  MENU_OPTIONS.forEach((option, index) => {
    const isActive = index === activeIndex;
    const pointer = isActive ? "›" : " ";
    const aliases = option.aliases.length > 0 ? ` (${option.aliases.join(", ")})` : "";
    lines.push(`${pointer} ${option.key}) ${option.label}${aliases}`);
    lines.push(`    ${option.hint}`);
  });
  return lines;
}

function buildRightPane(session: SessionState, showHelp: boolean): string[] {
  if (showHelp) {
    return ["=== help ===", ...HELP_LINES];
  }
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

function renderInteractiveMenu(activeIndex: number, session: SessionState, showHelp: boolean): void {
  const theme = activeTheme();
  const columns = output.columns ?? 120;
  const rows = output.rows ?? 32;
  const leftWidth = Math.max(42, Math.floor(columns * 0.45));
  const rightWidth = Math.max(24, columns - leftWidth - 3);
  const totalRows = Math.max(14, rows - 2);
  const leftLines = buildLeftPane(activeIndex);
  const rightLines = buildRightPane(session, showHelp).slice(-totalRows);
  const separator = " | ";

  output.write("\x1b[2J\x1b[H");
  for (let row = 0; row < totalRows; row += 1) {
    const leftRaw = leftLines[row] ?? "";
    const rightRaw = rightLines[row] ?? "";
    const isActive = leftRaw.startsWith("› ");
    const leftText = padText(leftRaw, leftWidth);
    const rightText = padText(rightRaw, rightWidth);
    if (isActive) {
      output.write(`${theme.accent}${leftText}${theme.reset}${separator}${rightText}\n`);
    } else {
      output.write(`${leftText}${theme.border}${separator}${theme.reset}${theme.muted}${rightText}${theme.reset}\n`);
    }
  }

  const footer = " ↑↓ Navigate | Enter Run | / Palette | ? Help | q Quit ";
  output.write(`${theme.border}${padText(footer, columns)}${theme.reset}\n`);
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
  let showHelp = false;

  return await new Promise<string>((resolve) => {
    let paletteOpen = false;

    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
    };

    const reopenRaw = () => {
      input.setRawMode(true);
      input.resume();
      renderInteractiveMenu(activeIndex, session, showHelp);
    };

    const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      if (paletteOpen) return;

      if (key.ctrl && key.name === "c") {
        activeIndexRef.value = activeIndex;
        cleanup();
        resolve("0");
        return;
      }
      if (key.name === "up") {
        activeIndex = (activeIndex - 1 + MENU_OPTIONS.length) % MENU_OPTIONS.length;
        renderInteractiveMenu(activeIndex, session, showHelp);
        return;
      }
      if (key.name === "down") {
        activeIndex = (activeIndex + 1) % MENU_OPTIONS.length;
        renderInteractiveMenu(activeIndex, session, showHelp);
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
      if (key.name === "escape" || str === "q") {
        activeIndexRef.value = activeIndex;
        cleanup();
        output.write("\x1b[2J\x1b[H");
        resolve("0");
        return;
      }
      if (str === "?") {
        showHelp = !showHelp;
        renderInteractiveMenu(activeIndex, session, showHelp);
        return;
      }
      if (str === "/") {
        paletteOpen = true;
        input.setRawMode(false);
        input.pause();
        rl.question("\nPalette (/): ").then((query) => {
          const match = matchPalette(query);
          if (match) {
            activeIndex = MENU_OPTIONS.findIndex((option) => option.key === match.key);
            activeIndexRef.value = activeIndex;
            cleanup();
            output.write("\x1b[2J\x1b[H");
            resolve(match.key);
            return;
          }
          session.lastStatus = `no palette match: ${query.trim() || "(empty)"}`;
          paletteOpen = false;
          reopenRaw();
        });
        return;
      }

      const normalized = normalizeChoice(typeof str === "string" ? str : "");
      if (normalized) {
        activeIndexRef.value = activeIndex;
        cleanup();
        output.write("\x1b[2J\x1b[H");
        resolve(normalized);
      }
    };

    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
    renderInteractiveMenu(activeIndex, session, showHelp);
  });
}

function appendOutput(session: SessionState, line: string): void {
  const trimmed = line.trimEnd();
  if (!trimmed) return;
  session.lastOutputLines.push(trimmed);
  if (session.lastOutputLines.length > 120) {
    session.lastOutputLines = session.lastOutputLines.slice(-120);
  }
}

async function consumeStream(
  stream: ReadableStream<Uint8Array> | null,
  prefix: string,
  session: SessionState,
  activeIndexRef: { value: number },
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      appendOutput(session, prefix ? `[${prefix}] ${part}` : part);
      if (input.isTTY && output.isTTY) {
        renderInteractiveMenu(activeIndexRef.value, session, false);
      }
    }
  }

  if (buffer.trim().length > 0) {
    appendOutput(session, prefix ? `[${prefix}] ${buffer}` : buffer);
  }
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

  session.lastOutputLines = [];

  const spinnerFrames = ["|", "/", "-", "\\"];
  let spinnerIndex = 0;
  const spinner = setInterval(() => {
    session.lastStatus = `running ${spinnerFrames[spinnerIndex % spinnerFrames.length]}`;
    spinnerIndex += 1;
    if (input.isTTY && output.isTTY) {
      renderInteractiveMenu(activeIndexRef.value, session, false);
    }
  }, 90);

  const stdoutTask = consumeStream(proc.stdout ?? null, "", session, activeIndexRef);
  const stderrTask = consumeStream(proc.stderr ?? null, "stderr", session, activeIndexRef);

  const exitCode = await proc.exited;
  await Promise.all([stdoutTask, stderrTask]);
  clearInterval(spinner);

  const status = exitCode === 0 ? "success" : `failed (exit ${exitCode})`;
  return { status, outputLines: session.lastOutputLines.slice(-120) };
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
        session.lastStatus = "invalid selection";
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
            session.lastStatus = "unknown option";
            break;
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        session.lastStatus = `error: ${message}`;
      }
    }
  } finally {
    rl.close();
  }
}
