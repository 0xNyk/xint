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

type CommandMeta = {
  summary: string;
  example: string;
  costHint: string;
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

type DashboardTab = "commands" | "output" | "help";

type UiState = {
  activeIndex: number;
  tab: DashboardTab;
  outputOffset: number;
  outputSearch: string;
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

const COMMAND_META: Record<string, CommandMeta> = {
  "1": {
    summary: "Discover relevant posts with ranked result quality.",
    example: 'xint search "open-source ai agents"',
    costHint: "Low-medium (depends on query depth)",
  },
  "2": {
    summary: "Surface current trend clusters globally or by location.",
    example: 'xint trends "San Francisco"',
    costHint: "Low",
  },
  "3": {
    summary: "Inspect profile metadata and recent activity context.",
    example: "xint profile 0xNyk",
    costHint: "Low",
  },
  "4": {
    summary: "Expand a tweet into threaded conversation context.",
    example: "xint thread https://x.com/.../status/...",
    costHint: "Medium",
  },
  "5": {
    summary: "Fetch article content from URL or tweet-linked article.",
    example: "xint article https://x.com/.../status/...",
    costHint: "Medium-high (fetch + parse)",
  },
  "6": {
    summary: "Display full command reference and flags.",
    example: "xint --help",
    costHint: "None",
  },
  "0": {
    summary: "Exit interactive dashboard.",
    example: "q",
    costHint: "None",
  },
};

const THEMES: Record<string, Theme> = {
  minimal: { accent: "\x1b[1m", border: "", muted: "", reset: "\x1b[0m" },
  classic: { accent: "\x1b[1;36m", border: "\x1b[2m", muted: "\x1b[2m", reset: "\x1b[0m" },
  neon: { accent: "\x1b[1;95m", border: "\x1b[38;5;45m", muted: "\x1b[38;5;244m", reset: "\x1b[0m" },
};

const HELP_LINES = [
  "Hotkeys",
  "  Up/Down: Move selection",
  "  Enter: Run selected command",
  "  Tab: Switch tabs",
  "  F: Output search (filter)",
  "  PgUp/PgDn: Scroll output",
  "  /: Command palette",
  "  ?: Open Help tab",
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

function tabLabel(tab: DashboardTab): string {
  if (tab === "commands") return "Commands";
  if (tab === "help") return "Help";
  return "Output";
}

function nextTab(tab: DashboardTab): DashboardTab {
  if (tab === "commands") return "output";
  if (tab === "output") return "help";
  return "commands";
}

function buildMenuLines(activeIndex: number): string[] {
  const lines: string[] = ["Menu", ""];
  MENU_OPTIONS.forEach((option, index) => {
    const pointer = index === activeIndex ? ">" : " ";
    const aliases = option.aliases.length > 0 ? ` (${option.aliases.join(", ")})` : "";
    lines.push(`${pointer} ${option.key}) ${option.label}${aliases}`);
    lines.push(`    ${option.hint}`);
  });
  return lines;
}

function buildCommandDrawer(activeIndex: number): string[] {
  const selected = MENU_OPTIONS[activeIndex] ?? MENU_OPTIONS[0];
  const meta = COMMAND_META[selected.key] ?? {
    summary: "No metadata available.",
    example: "-",
    costHint: "Unknown",
  };
  return [
    "Command details",
    "",
    `Selected: ${selected.label}`,
    `Summary: ${meta.summary}`,
    `Example: ${meta.example}`,
    `Cost: ${meta.costHint}`,
  ];
}

function outputViewLines(session: SessionState, uiState: UiState, viewport: number): string[] {
  const source = session.lastOutputLines;
  const q = uiState.outputSearch.trim().toLowerCase();
  const filtered =
    q.length === 0 ? source : source.filter((line) => line.toLowerCase().includes(q));

  const visible = Math.max(1, viewport);
  const maxOffset = Math.max(0, filtered.length - visible);
  uiState.outputOffset = Math.min(uiState.outputOffset, maxOffset);

  const start = Math.max(0, filtered.length - visible - uiState.outputOffset);
  const end = Math.max(start, Math.min(filtered.length, start + visible));
  const windowLines = filtered.slice(start, end);

  const lines: string[] = [
    "Last run",
    "",
    `command: ${session.lastCommand ?? "-"}`,
    `status: ${session.lastStatus ?? "-"}`,
    `filter: ${uiState.outputSearch || "(none)"}`,
    "",
    "output:",
  ];

  if (windowLines.length === 0) {
    lines.push("(no output lines for current filter)");
  } else {
    lines.push(...windowLines);
  }

  const total = filtered.length;
  const from = total === 0 ? 0 : start + 1;
  const to = total === 0 ? 0 : end;
  lines.push("");
  lines.push(`view ${from}-${to} of ${total} | offset ${uiState.outputOffset}`);

  return lines;
}

function buildTabLines(session: SessionState, uiState: UiState, viewport: number): string[] {
  if (uiState.tab === "help") {
    return ["Help", "", ...HELP_LINES];
  }
  if (uiState.tab === "commands") {
    return buildCommandDrawer(uiState.activeIndex);
  }
  return outputViewLines(session, uiState, viewport);
}

function renderDoublePane(uiState: UiState, session: SessionState, columns: number, rows: number): void {
  const theme = activeTheme();
  const leftBoxWidth = Math.max(46, Math.floor(columns * 0.45));
  const rightBoxWidth = Math.max(30, columns - leftBoxWidth - 1);
  const leftInner = Math.max(20, leftBoxWidth - 2);
  const rightInner = Math.max(20, rightBoxWidth - 2);
  const totalRows = Math.max(12, rows - 7);

  const leftLines = buildMenuLines(uiState.activeIndex);
  const rightLines = buildTabLines(session, uiState, totalRows).slice(-totalRows);
  const tabs = (["commands", "output", "help"] as DashboardTab[])
    .map((tab, index) => {
      const label = `${index + 1}:${tabLabel(tab)}`;
      return tab === uiState.tab ? `${theme.accent}[ ${label} ]${theme.reset}` : `[ ${label} ]`;
    })
    .join(" ");

  output.write("\x1b[2J\x1b[H");
  output.write(`${theme.border}+${"-".repeat(Math.max(1, columns - 2))}+${theme.reset}\n`);
  output.write(
    `${theme.border}|${theme.reset}${padText(` xint dashboard ${tabs}`, Math.max(1, columns - 2))}${theme.border}|${theme.reset}\n`,
  );
  output.write(`${theme.border}+${"-".repeat(leftBoxWidth - 2)}+ +${"-".repeat(rightBoxWidth - 2)}+${theme.reset}\n`);

  for (let row = 0; row < totalRows; row += 1) {
    const leftRaw = leftLines[row] ?? "";
    const rightRaw = rightLines[row] ?? "";
    const leftText = padText(leftRaw, leftInner);
    const rightText = padText(rightRaw, rightInner);
    const leftSegment = leftRaw.startsWith("> ")
      ? `${theme.accent}${leftText}${theme.reset}`
      : `${theme.muted}${leftText}${theme.reset}`;

    output.write(
      `${theme.border}|${theme.reset}${leftSegment}${theme.border}|${theme.reset} ${theme.border}|${theme.reset}${theme.muted}${rightText}${theme.reset}${theme.border}|${theme.reset}\n`,
    );
  }

  output.write(`${theme.border}+${"-".repeat(leftBoxWidth - 2)}+ +${"-".repeat(rightBoxWidth - 2)}+${theme.reset}\n`);
  const footer = " Up/Down Navigate | Enter Run | Tab Tabs | F Search Output | PgUp/PgDn Scroll | / Palette | q Quit ";
  output.write(`${theme.border}|${theme.reset}${padText(footer, Math.max(1, columns - 2))}${theme.border}|${theme.reset}\n`);
  output.write(`${theme.border}+${"-".repeat(Math.max(1, columns - 2))}+${theme.reset}\n`);
}

function renderSinglePane(uiState: UiState, session: SessionState, columns: number, rows: number): void {
  const theme = activeTheme();
  const width = Math.max(30, columns - 2);
  const totalRows = Math.max(10, rows - 6);
  const tabs = (["commands", "output", "help"] as DashboardTab[])
    .map((tab, index) => {
      const label = `${index + 1}:${tabLabel(tab)}`;
      return tab === uiState.tab ? `${theme.accent}[ ${label} ]${theme.reset}` : `[ ${label} ]`;
    })
    .join(" ");

  const lines =
    uiState.tab === "commands"
      ? [...buildMenuLines(uiState.activeIndex), "", ...buildCommandDrawer(uiState.activeIndex)]
      : buildTabLines(session, uiState, totalRows * 2);

  output.write("\x1b[2J\x1b[H");
  output.write(`${theme.border}+${"-".repeat(width)}+${theme.reset}\n`);
  output.write(`${theme.border}|${theme.reset}${padText(` xint dashboard ${tabs}`, width)}${theme.border}|${theme.reset}\n`);
  output.write(`${theme.border}+${"-".repeat(width)}+${theme.reset}\n`);

  for (const line of lines.slice(-totalRows)) {
    const row = padText(line, width);
    if (line.startsWith("> ")) {
      output.write(`${theme.border}|${theme.reset}${theme.accent}${row}${theme.reset}${theme.border}|${theme.reset}\n`);
    } else {
      output.write(`${theme.border}|${theme.reset}${theme.muted}${row}${theme.reset}${theme.border}|${theme.reset}\n`);
    }
  }

  const rendered = Math.min(totalRows, lines.length);
  for (let i = rendered; i < totalRows; i += 1) {
    output.write(`${theme.border}|${theme.reset}${" ".repeat(width)}${theme.border}|${theme.reset}\n`);
  }

  const footer = " Tab Tabs | F Search Output | PgUp/PgDn Scroll | / Palette | q Quit ";
  output.write(`${theme.border}+${"-".repeat(width)}+${theme.reset}\n`);
  output.write(`${theme.border}|${theme.reset}${padText(footer, width)}${theme.border}|${theme.reset}\n`);
  output.write(`${theme.border}+${"-".repeat(width)}+${theme.reset}\n`);
}

function renderDashboard(uiState: UiState, session: SessionState): void {
  const columns = output.columns ?? 120;
  const rows = output.rows ?? 32;
  if (columns < 110) {
    renderSinglePane(uiState, session, columns, rows);
  } else {
    renderDoublePane(uiState, session, columns, rows);
  }
}

async function selectOption(
  rl: ReturnType<typeof createInterface>,
  session: SessionState,
  uiState: UiState,
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

  return await new Promise<string>((resolve) => {
    let paletteOpen = false;

    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
    };

    const reopenRaw = () => {
      input.setRawMode(true);
      renderDashboard(uiState, session);
    };

    const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      if (paletteOpen) return;

      if (key.ctrl && key.name === "c") {
        cleanup();
        resolve("0");
        return;
      }

      if (key.name === "up") {
        uiState.activeIndex = (uiState.activeIndex - 1 + MENU_OPTIONS.length) % MENU_OPTIONS.length;
        renderDashboard(uiState, session);
        return;
      }
      if (key.name === "down") {
        uiState.activeIndex = (uiState.activeIndex + 1) % MENU_OPTIONS.length;
        renderDashboard(uiState, session);
        return;
      }
      if (key.name === "tab") {
        uiState.tab = nextTab(uiState.tab);
        renderDashboard(uiState, session);
        return;
      }
      if (key.name === "pageup" && uiState.tab === "output") {
        uiState.outputOffset += 10;
        renderDashboard(uiState, session);
        return;
      }
      if (key.name === "pagedown" && uiState.tab === "output") {
        uiState.outputOffset = Math.max(0, uiState.outputOffset - 10);
        renderDashboard(uiState, session);
        return;
      }
      if (key.name === "return") {
        const selected = MENU_OPTIONS[uiState.activeIndex];
        cleanup();
        output.write("\x1b[2J\x1b[H");
        resolve(selected?.key ?? "0");
        return;
      }
      if (key.name === "escape" || str === "q") {
        cleanup();
        output.write("\x1b[2J\x1b[H");
        resolve("0");
        return;
      }
      if (str === "?") {
        uiState.tab = "help";
        renderDashboard(uiState, session);
        return;
      }
      if (str === "1") {
        uiState.tab = "commands";
        renderDashboard(uiState, session);
        return;
      }
      if (str === "2") {
        uiState.tab = "output";
        renderDashboard(uiState, session);
        return;
      }
      if (str === "3") {
        uiState.tab = "help";
        renderDashboard(uiState, session);
        return;
      }
      if (str?.toLowerCase() === "f") {
        paletteOpen = true;
        input.setRawMode(false);
        rl.question("\nOutput search (blank clears): ").then((query) => {
          uiState.outputSearch = query.trim();
          uiState.outputOffset = 0;
          uiState.tab = "output";
          session.lastStatus = uiState.outputSearch
            ? `output filter active: ${uiState.outputSearch}`
            : "output filter cleared";
          paletteOpen = false;
          reopenRaw();
        });
        return;
      }
      if (str === "/") {
        paletteOpen = true;
        input.setRawMode(false);
        rl.question("\nPalette (/): ").then((query) => {
          const match = matchPalette(query);
          if (match) {
            uiState.activeIndex = MENU_OPTIONS.findIndex((option) => option.key === match.key);
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
        cleanup();
        output.write("\x1b[2J\x1b[H");
        resolve(normalized);
      }
    };

    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
    renderDashboard(uiState, session);
  });
}

function appendOutput(session: SessionState, line: string): void {
  const trimmed = line.trimEnd();
  if (!trimmed) return;
  session.lastOutputLines.push(trimmed);
  if (session.lastOutputLines.length > 1200) {
    session.lastOutputLines = session.lastOutputLines.slice(-1200);
  }
}

async function consumeStream(
  stream: ReadableStream<Uint8Array> | null,
  prefix: string,
  session: SessionState,
  uiState: UiState,
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
        renderDashboard(uiState, session);
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
  uiState: UiState,
): Promise<{ status: string; outputLines: string[] }> {
  const scriptPath = join(import.meta.dir, "..", "xint.ts");
  const proc = Bun.spawn({
    cmd: [process.execPath, scriptPath, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  session.lastOutputLines = [];
  uiState.outputOffset = 0;

  const spinnerFrames = ["|", "/", "-", "\\"];
  let spinnerIndex = 0;
  const spinner = setInterval(() => {
    session.lastStatus = `running ${spinnerFrames[spinnerIndex % spinnerFrames.length]}`;
    spinnerIndex += 1;
    if (input.isTTY && output.isTTY) {
      renderDashboard(uiState, session);
    }
  }, 90);

  const stdoutTask = consumeStream(proc.stdout ?? null, "", session, uiState);
  const stderrTask = consumeStream(proc.stderr ?? null, "stderr", session, uiState);

  const exitCode = await proc.exited;
  await Promise.all([stdoutTask, stderrTask]);
  clearInterval(spinner);

  const status = exitCode === 0 ? "success" : `failed (exit ${exitCode})`;
  return { status, outputLines: session.lastOutputLines.slice(-1200) };
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
  const uiState: UiState = {
    activeIndex: initialIndex >= 0 ? initialIndex : 0,
    tab: "output",
    outputOffset: 0,
    outputSearch: "",
  };
  const session: SessionState = {
    lastOutputLines: [],
  };
  const rl = createInterface({ input, output });

  try {
    for (;;) {
      const choice = await selectOption(rl, session, uiState);
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
                await rl.question(`Search query${session.lastSearch ? ` [${session.lastSearch}]` : ""}: `),
                session.lastSearch,
              ),
              "Query",
            );
            session.lastSearch = query;
            session.lastCommand = `xint search ${query}`;
            const result = await runSubcommand(["search", query], session, uiState);
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
            const result = await runSubcommand(location ? ["trends", location] : ["trends"], session, uiState);
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
            const result = await runSubcommand(["profile", username], session, uiState);
            session.lastStatus = result.status;
            session.lastOutputLines = result.outputLines;
            break;
          }
          case "4": {
            const tweetRef = requireInput(
              promptWithDefault(
                await rl.question(`Tweet ID or URL${session.lastTweetRef ? ` [${session.lastTweetRef}]` : ""}: `),
                session.lastTweetRef,
              ),
              "Tweet ID/URL",
            );
            session.lastTweetRef = tweetRef;
            session.lastCommand = `xint thread ${tweetRef}`;
            const result = await runSubcommand(["thread", tweetRef], session, uiState);
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
            const result = await runSubcommand(["article", url], session, uiState);
            session.lastStatus = result.status;
            session.lastOutputLines = result.outputLines;
            break;
          }
          case "6": {
            session.lastCommand = "xint --help";
            const result = await runSubcommand(["--help"], session, uiState);
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
