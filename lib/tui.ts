import { join } from "path";
import { createInterface } from "readline/promises";
import { emitKeypressEvents } from "readline";
import { stdin as input, stdout as output } from "process";
import {
  INTERACTIVE_ACTIONS,
  normalizeInteractiveChoice,
  scoreInteractiveAction,
  type InteractiveAction,
} from "./actions";
import { buildTuiExecutionPlan } from "./tui_adapter";

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
  inlinePromptLabel?: string;
  inlinePromptValue?: string;
};
type UiPhase = "IDLE" | "INPUT" | "RUNNING" | "DONE" | "ERROR";

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

function clipText(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width <= 3) return ".".repeat(width);
  return `${value.slice(0, width - 3)}...`;
}

function padText(value: string, width: number): string {
  return clipText(value, width).padEnd(width, " ");
}

function matchPalette(query: string): InteractiveAction | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  let best: InteractiveAction | null = null;
  let bestScore = 0;
  for (const option of INTERACTIVE_ACTIONS) {
    const score = scoreInteractiveAction(option, trimmed);
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
  INTERACTIVE_ACTIONS.forEach((option, index) => {
    const pointer = index === activeIndex ? ">" : " ";
    const aliases = option.aliases.length > 0 ? ` (${option.aliases.join(", ")})` : "";
    lines.push(`${pointer} ${option.key}) ${option.label}${aliases}`);
    lines.push(`    ${option.hint}`);
  });
  return lines;
}

function buildCommandDrawer(activeIndex: number): string[] {
  const selected = INTERACTIVE_ACTIONS[activeIndex] ?? INTERACTIVE_ACTIONS[0];
  return [
    "Command details",
    "",
    `Selected: ${selected.label}`,
    `Summary: ${selected.summary}`,
    `Example: ${selected.example}`,
    `Cost: ${selected.costHint}`,
  ];
}

function resolveUiPhase(session: SessionState, uiState: UiState): UiPhase {
  if (uiState.inlinePromptLabel) return "INPUT";
  const status = (session.lastStatus ?? "").toLowerCase();
  if (status.startsWith("running")) return "RUNNING";
  if (status.includes("failed") || status.includes("error")) return "ERROR";
  if (status.includes("success")) return "DONE";
  return "IDLE";
}

function phaseBadge(phase: UiPhase): string {
  if (phase === "RUNNING") {
    const frames = ["|", "/", "-", "\\"];
    const index = Math.floor(Date.now() / 120) % frames.length;
    return `[${phase} ${frames[index]}]`;
  }
  if (phase === "INPUT") return `[${phase} <>]`;
  if (phase === "DONE") return `[${phase} ok]`;
  if (phase === "ERROR") return `[${phase} !!]`;
  return `[${phase}]`;
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
    `phase: ${phaseBadge(resolveUiPhase(session, uiState))}`,
    `command: ${session.lastCommand ?? "-"}`,
    `status: ${session.lastStatus ?? "-"}`,
    `filter: ${uiState.outputSearch || "(none)"}`,
    "",
    "output:",
  ];

  if (uiState.inlinePromptLabel) {
    lines.push("");
    lines.push(`${uiState.inlinePromptLabel}`);
    lines.push(`> ${(uiState.inlinePromptValue ?? "")}█`);
    lines.push("");
  }

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

function buildStatusLine(session: SessionState, uiState: UiState, width: number): string {
  const selected = INTERACTIVE_ACTIONS[uiState.activeIndex] ?? INTERACTIVE_ACTIONS[0];
  const phase = resolveUiPhase(session, uiState);
  const focus = uiState.inlinePromptLabel
    ? `input:${uiState.inlinePromptLabel}`
    : `tab:${tabLabel(uiState.tab)}`;
  const status = session.lastStatus ?? "-";
  return padText(
    ` ${phaseBadge(phase)} ${selected.key}:${selected.label} | ${focus} | ${status} `,
    Math.max(1, width),
  );
}

function renderDoublePane(uiState: UiState, session: SessionState, columns: number, rows: number): void {
  const theme = activeTheme();
  const leftBoxWidth = Math.max(46, Math.floor(columns * 0.45));
  const rightBoxWidth = Math.max(30, columns - leftBoxWidth - 1);
  const leftInner = Math.max(20, leftBoxWidth - 2);
  const rightInner = Math.max(20, rightBoxWidth - 2);
  const totalRows = Math.max(12, rows - 8);

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
  output.write(
    `${theme.border}|${theme.reset}${theme.accent}${buildStatusLine(session, uiState, Math.max(1, columns - 2))}${theme.reset}${theme.border}|${theme.reset}\n`,
  );
  const footer = " Up/Down Navigate | Enter Run | Tab Tabs | F Search Output | PgUp/PgDn Scroll | / Palette | q Quit ";
  output.write(`${theme.border}|${theme.reset}${padText(footer, Math.max(1, columns - 2))}${theme.border}|${theme.reset}\n`);
  output.write(`${theme.border}+${"-".repeat(Math.max(1, columns - 2))}+${theme.reset}\n`);
}

function renderSinglePane(uiState: UiState, session: SessionState, columns: number, rows: number): void {
  const theme = activeTheme();
  const width = Math.max(30, columns - 2);
  const totalRows = Math.max(10, rows - 7);
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
  output.write(
    `${theme.border}|${theme.reset}${theme.accent}${buildStatusLine(session, uiState, width)}${theme.reset}${theme.border}|${theme.reset}\n`,
  );
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
    INTERACTIVE_ACTIONS.forEach((option) => {
      const aliases = option.aliases.length > 0 ? ` (${option.aliases.join(", ")})` : "";
      output.write(`${option.key}) ${option.label}${aliases}\n`);
    });
    return normalizeInteractiveChoice(await rl.question("\nSelect option (number or alias): "));
  }

  emitKeypressEvents(input);

  return await new Promise<string>((resolve) => {

    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
    };

    const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        resolve("0");
        return;
      }

      if (key.name === "up") {
        uiState.activeIndex =
          (uiState.activeIndex - 1 + INTERACTIVE_ACTIONS.length) % INTERACTIVE_ACTIONS.length;
        renderDashboard(uiState, session);
        return;
      }
      if (key.name === "down") {
        uiState.activeIndex = (uiState.activeIndex + 1) % INTERACTIVE_ACTIONS.length;
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
        const selected = INTERACTIVE_ACTIONS[uiState.activeIndex];
        uiState.tab = "output";
        cleanup();
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
        uiState.tab = "output";
        cleanup();
        resolve("__filter__");
        return;
      }
      if (str === "/") {
        uiState.tab = "output";
        cleanup();
        resolve("__palette__");
        return;
      }

      const normalized = normalizeInteractiveChoice(typeof str === "string" ? str : "");
      if (normalized) {
        uiState.tab = "output";
        cleanup();
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

  const stdoutTask = consumeStream(proc.stdout ?? null, "", session);
  const stderrTask = consumeStream(proc.stderr ?? null, "stderr", session);

  const exitCode = await proc.exited;
  await Promise.all([stdoutTask, stderrTask]);
  clearInterval(spinner);
  if (input.isTTY && output.isTTY) {
    renderDashboard(uiState, session);
  }

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

async function questionInDashboard(
  rl: ReturnType<typeof createInterface>,
  label: string,
  uiState: UiState,
  session: SessionState,
): Promise<string> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    return await rl.question(`\n${label}`);
  }

  emitKeypressEvents(input);
  uiState.tab = "output";
  uiState.inlinePromptLabel = label;
  uiState.inlinePromptValue = "";
  renderDashboard(uiState, session);

  return await new Promise<string>((resolve) => {
    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      uiState.inlinePromptLabel = undefined;
      uiState.inlinePromptValue = undefined;
      renderDashboard(uiState, session);
    };

    const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        resolve("");
        return;
      }
      if (key.name === "escape") {
        cleanup();
        resolve("");
        return;
      }
      if (key.name === "return") {
        const value = uiState.inlinePromptValue ?? "";
        cleanup();
        resolve(value);
        return;
      }
      if (key.name === "backspace") {
        uiState.inlinePromptValue = (uiState.inlinePromptValue ?? "").slice(0, -1);
        renderDashboard(uiState, session);
        return;
      }
      if (typeof str === "string" && str.length > 0 && !key.ctrl) {
        uiState.inlinePromptValue = `${uiState.inlinePromptValue ?? ""}${str}`;
        renderDashboard(uiState, session);
      }
    };

    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
  });
}

export async function cmdTui(): Promise<void> {
  const initialIndex = INTERACTIVE_ACTIONS.findIndex((option) => option.key === "1");
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
      let choice = await selectOption(rl, session, uiState);
      if (choice === "0") {
        console.log("Exiting xint interactive mode.");
        break;
      }
      if (choice === "__filter__") {
        const query = await questionInDashboard(rl, "Output search (blank clears): ", uiState, session);
        uiState.outputSearch = query.trim();
        uiState.outputOffset = 0;
        uiState.tab = "output";
        session.lastStatus = uiState.outputSearch
          ? `output filter active: ${uiState.outputSearch}`
          : "output filter cleared";
        continue;
      }
      if (choice === "__palette__") {
        const query = await questionInDashboard(rl, "Palette (/): ", uiState, session);
        const match = matchPalette(query);
        if (!match) {
          session.lastStatus = `no palette match: ${query.trim() || "(empty)"}`;
          continue;
        }
        uiState.activeIndex = INTERACTIVE_ACTIONS.findIndex((option) => option.key === match.key);
        uiState.tab = "output";
        choice = match.key;
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
                await questionInDashboard(
                  rl,
                  `Search query${session.lastSearch ? ` [${session.lastSearch}]` : ""}: `,
                  uiState,
                  session,
                ),
                session.lastSearch,
              ),
              "Query",
            );
            session.lastSearch = query;
            const planResult = buildTuiExecutionPlan(choice, query);
            if (planResult.type === "error" || !planResult.data) throw new Error(planResult.message);
            session.lastCommand = planResult.data.command;
            const result = await runSubcommand(planResult.data.args, session, uiState);
            session.lastStatus = result.status;
            session.lastOutputLines = result.outputLines;
            break;
          }
          case "2": {
            const location = promptWithDefault(
              await questionInDashboard(
                rl,
                `Location (blank for worldwide)${session.lastLocation ? ` [${session.lastLocation}]` : ""}: `,
                uiState,
                session,
              ),
              session.lastLocation,
            );
            session.lastLocation = location;
            const planResult = buildTuiExecutionPlan(choice, location);
            if (planResult.type === "error" || !planResult.data) throw new Error(planResult.message);
            session.lastCommand = planResult.data.command;
            const result = await runSubcommand(planResult.data.args, session, uiState);
            session.lastStatus = result.status;
            session.lastOutputLines = result.outputLines;
            break;
          }
          case "3": {
            const username = requireInput(
              promptWithDefault(
                await questionInDashboard(
                  rl,
                  `Username (@optional)${session.lastUsername ? ` [${session.lastUsername}]` : ""}: `,
                  uiState,
                  session,
                ),
                session.lastUsername,
              ),
              "Username",
            ).replace(/^@/, "");
            session.lastUsername = username;
            const planResult = buildTuiExecutionPlan(choice, username);
            if (planResult.type === "error" || !planResult.data) throw new Error(planResult.message);
            session.lastCommand = planResult.data.command;
            const result = await runSubcommand(planResult.data.args, session, uiState);
            session.lastStatus = result.status;
            session.lastOutputLines = result.outputLines;
            break;
          }
          case "4": {
            const tweetRef = requireInput(
              promptWithDefault(
                await questionInDashboard(
                  rl,
                  `Tweet ID or URL${session.lastTweetRef ? ` [${session.lastTweetRef}]` : ""}: `,
                  uiState,
                  session,
                ),
                session.lastTweetRef,
              ),
              "Tweet ID/URL",
            );
            session.lastTweetRef = tweetRef;
            const planResult = buildTuiExecutionPlan(choice, tweetRef);
            if (planResult.type === "error" || !planResult.data) throw new Error(planResult.message);
            session.lastCommand = planResult.data.command;
            const result = await runSubcommand(planResult.data.args, session, uiState);
            session.lastStatus = result.status;
            session.lastOutputLines = result.outputLines;
            break;
          }
          case "5": {
            const url = requireInput(
              promptWithDefault(
                await questionInDashboard(
                  rl,
                  `Article URL or Tweet URL${session.lastArticleUrl ? ` [${session.lastArticleUrl}]` : ""}: `,
                  uiState,
                  session,
                ),
                session.lastArticleUrl,
              ),
              "Article URL",
            );
            session.lastArticleUrl = url;
            const planResult = buildTuiExecutionPlan(choice, url);
            if (planResult.type === "error" || !planResult.data) throw new Error(planResult.message);
            session.lastCommand = planResult.data.command;
            const result = await runSubcommand(planResult.data.args, session, uiState);
            session.lastStatus = result.status;
            session.lastOutputLines = result.outputLines;
            break;
          }
          case "6": {
            const planResult = buildTuiExecutionPlan(choice);
            if (planResult.type === "error" || !planResult.data) throw new Error(planResult.message);
            session.lastCommand = planResult.data.command;
            const result = await runSubcommand(planResult.data.args, session, uiState);
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
