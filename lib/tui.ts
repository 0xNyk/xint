import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
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

const HISTORY_MAX = 50;
const HISTORY_FILE = join(import.meta.dir, "..", "data", "tui-history.json");

type HistoryStore = Record<string, string[]>;

function loadHistory(): HistoryStore {
  try {
    if (!existsSync(HISTORY_FILE)) return {};
    const raw = readFileSync(HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const store: HistoryStore = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        store[key] = value.filter((v): v is string => typeof v === "string").slice(-HISTORY_MAX);
      }
    }
    return store;
  } catch {
    return {};
  }
}

function saveHistory(store: HistoryStore): void {
  try {
    const dir = join(import.meta.dir, "..", "data");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(HISTORY_FILE, JSON.stringify(store, null, 2), "utf8");
  } catch {
    // best-effort persistence — don't crash TUI on write failure
  }
}

function pushHistory(store: HistoryStore, category: string, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  if (!store[category]) store[category] = [];
  const entries = store[category];
  const existing = entries.indexOf(trimmed);
  if (existing !== -1) entries.splice(existing, 1);
  entries.push(trimmed);
  if (entries.length > HISTORY_MAX) {
    store[category] = entries.slice(-HISTORY_MAX);
  }
}

function historyForCategory(store: HistoryStore, category: string): string[] {
  return store[category] ?? [];
}

type SessionState = {
  lastSearch?: string;
  lastLocation?: string;
  lastUsername?: string;
  lastTweetRef?: string;
  lastArticleUrl?: string;
  lastCommand?: string;
  lastStatus?: string;
  lastError?: string;
  lastStdoutLines: string[];
  lastStderrLines: string[];
  lastOutputLines: string[];
};

type Theme = {
  accent: string;
  border: string;
  muted: string;
  hero: string;
  reset: string;
};

type LayoutPreset = "full" | "compact" | "focus";
type DashboardTab = "commands" | "output" | "help";

type FocusPane = "left" | "right";

type UiState = {
  activeIndex: number;
  tab: DashboardTab;
  outputOffset: number;
  outputSearch: string;
  showStderr: boolean;
  focusedPane: FocusPane;
  inlinePromptLabel?: string;
  inlinePromptValue?: string;
  historyCategory?: string;
  historyCursor: number; // -1 = editing new entry, 0..N = browsing history from newest
  historyDraft?: string; // the value typed before browsing history
};

type UiPhase = "IDLE" | "INPUT" | "RUNNING" | "DONE" | "ERROR";
type KeypressLike = { name?: string; ctrl?: boolean };
type RunEvent =
  | { type: "tick"; spinner: string }
  | { type: "exit"; code: number };
type BorderChars = {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
  tj: string;
  bj: string;
  lj: string;
  rj: string;
  x: string;
};

const THEMES: Record<string, Theme> = {
  minimal: { accent: "\x1b[1m", border: "", muted: "", hero: "\x1b[1m", reset: "\x1b[0m" },
  classic: { accent: "\x1b[1;36m", border: "\x1b[2m", muted: "\x1b[2m", hero: "\x1b[1;34m", reset: "\x1b[0m" },
  neon: { accent: "\x1b[1;95m", border: "\x1b[38;5;45m", muted: "\x1b[38;5;244m", hero: "\x1b[1;92m", reset: "\x1b[0m" },
  ocean: { accent: "\x1b[1;96m", border: "\x1b[38;5;39m", muted: "\x1b[38;5;244m", hero: "\x1b[1;94m", reset: "\x1b[0m" },
  amber: { accent: "\x1b[1;33m", border: "\x1b[38;5;214m", muted: "\x1b[38;5;244m", hero: "\x1b[1;220m", reset: "\x1b[0m" },
};

function buildContextHelp(phase: UiPhase, tab: DashboardTab, layout: LayoutPreset): string[] {
  const lines: string[] = ["Help"];
  lines.push("");

  if (phase === "INPUT") {
    lines.push("Prompt mode:");
    lines.push("  Enter     Submit value");
    lines.push("  Esc       Cancel prompt");
    lines.push("  Up/Down   Browse history");
    lines.push("  Backspace Delete character");
    lines.push("");
    lines.push("History entries are saved per input type.");
  } else if (phase === "RUNNING") {
    lines.push("Command running:");
    lines.push("  PgUp/PgDn  Scroll output");
    lines.push("  e          Toggle stdout/stderr");
    lines.push("");
    lines.push("Output streams update live as the command runs.");
  } else {
    // IDLE, DONE, ERROR
    lines.push("Navigation:");
    lines.push("  Up/Down    Move selection");
    lines.push("  Enter      Run selected command");
    lines.push("  Tab        Cycle tabs (Commands > Output > Help)");
    if (layout === "full") {
      lines.push("  h/l        Switch left/right pane focus");
    }
    lines.push("  /          Command palette (fuzzy search)");
    lines.push("  q or Esc   Exit");
    lines.push("");
    lines.push("Output controls:");
    lines.push("  PgUp/PgDn  Scroll output");
    lines.push("  f          Filter output text");
    lines.push("  e          Toggle stdout/stderr stream");
    lines.push("  1/2/3      Jump to Commands/Output/Help tab");
  }

  lines.push("");
  lines.push("Layout presets (XINT_TUI_LAYOUT env var):");
  lines.push(`  full     Dual-pane with hero and tracker${layout === "full" ? " (active)" : ""}`);
  lines.push(`  compact  Single-pane, no hero or tracker${layout === "compact" ? " (active)" : ""}`);
  lines.push(`  focus    Output-only, commands via palette${layout === "focus" ? " (active)" : ""}`);

  return lines;
}

let cachedTheme: Theme | null = null;
let cachedThemeAt = 0;
const THEME_CACHE_TTL = 5000; // re-read theme file at most every 5s

function activeTheme(): Theme {
  const now = Date.now();
  if (cachedTheme && now - cachedThemeAt < THEME_CACHE_TTL) return cachedTheme;
  const requested = (process.env.XINT_TUI_THEME || "classic").toLowerCase();
  const base = THEMES[requested] ?? THEMES.classic;
  const fromFile = loadThemeFromFile();
  cachedTheme = { ...base, ...fromFile };
  cachedThemeAt = now;
  return cachedTheme;
}

function loadThemeFromFile(): Partial<Theme> {
  const path = process.env.XINT_TUI_THEME_FILE;
  if (!path) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<Record<keyof Theme, unknown>>;
    const out: Partial<Theme> = {};
    for (const key of ["accent", "border", "muted", "hero", "reset"] as Array<keyof Theme>) {
      if (typeof parsed[key] === "string") out[key] = parsed[key] as string;
    }
    return out;
  } catch {
    return {};
  }
}

function activeLayout(): LayoutPreset {
  const raw = (process.env.XINT_TUI_LAYOUT || "full").toLowerCase();
  if (raw === "compact" || raw === "focus") return raw;
  return "full";
}

function isHeroEnabled(): boolean {
  if (activeLayout() !== "full") return false;
  return process.env.XINT_TUI_HERO !== "0";
}

function buildHeroLine(uiState: UiState, session: SessionState, width: number): string {
  const phase = resolveUiPhase(session, uiState);
  const palette = phase === "RUNNING" ? ["▁", "▂", "▃", "▄", "▅", "▆", "▇"] : ["·", "•", "·", "•", "·"];
  const tick = Math.floor(Date.now() / 110);
  const wave = Array.from({ length: 12 }, (_, i) => palette[(tick + i) % palette.length]).join("");
  return padText(` xint intelligence console  ${wave}`, width);
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

function activeBorderChars(): BorderChars {
  if (process.env.XINT_TUI_ASCII === "1") {
    return { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", tj: "+", bj: "+", lj: "+", rj: "+", x: "+" };
  }
  return { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", tj: "┬", bj: "┴", lj: "├", rj: "┤", x: "┼" };
}

function iconForAction(key: string): string {
  if (process.env.XINT_TUI_ICONS === "0") return "";
  const icons: Record<string, string> = {
    "1": "⌕",
    "2": "◍",
    "3": "◉",
    "4": "↳",
    "5": "✦",
    "6": "?",
  };
  return icons[key] ? `${icons[key]} ` : "";
}

function buildTabs(uiState: UiState): string {
  const icon = (tab: DashboardTab): string => {
    if (process.env.XINT_TUI_ICONS === "0") return "";
    if (tab === "commands") return "⌘ ";
    if (tab === "output") return "▤ ";
    return "? ";
  };

  return (["commands", "output", "help"] as DashboardTab[])
    .map((tab, index) => {
      const label = `${index + 1}:${icon(tab)}${tabLabel(tab)}`;
      return tab === uiState.tab ? `‹${label}›` : `[${label}]`;
    })
    .join(" ");
}

function isTrackerEnabled(): boolean {
  return activeLayout() === "full";
}

function buildHeaderTracker(uiState: UiState, width: number): string {
  if (!isTrackerEnabled()) return "";
  const railWidth = Math.max(8, Math.min(18, width));
  const cursorBasis = uiState.inlinePromptLabel
    ? (uiState.inlinePromptValue ?? "").length
    : uiState.activeIndex * 4 + uiState.outputOffset;
  const pos = cursorBasis % railWidth;
  const left = "·".repeat(pos);
  const right = "·".repeat(Math.max(0, railWidth - pos - 1));
  return `focus ${left}●${right}`;
}

const SPINNER_FRAMES = ["|", "/", "-", "\\"];
const RE_ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const RE_ANSI_OSC = /\x1b\][^\x07]*(\x07|\x1b\\)/g;
const RE_CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

function sanitizeOutputLine(line: string): string {
  return line
    .replace(RE_ANSI_OSC, "")
    .replace(RE_ANSI_CSI, "")
    .replace(RE_CONTROL, "");
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
    lines.push(`${pointer} ${option.key}) ${iconForAction(option.key)}${option.label}${aliases}`);
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

function buildContextualFooter(phase: UiPhase, uiState: UiState): string {
  if (phase === "INPUT") {
    return " Enter Submit • Esc Cancel • ↑↓ History • Backspace Delete ";
  }
  if (phase === "RUNNING") {
    return " PgUp/PgDn Scroll • e Stream • f Filter • Waiting for command... ";
  }
  if (phase === "ERROR" || phase === "DONE") {
    return " ↑↓ Move • Enter Run • Tab Views • f Filter • e Stream • / Palette • q Quit ";
  }
  // IDLE
  if (uiState.focusedPane === "right") {
    return " h Left pane • PgUp/PgDn Scroll • f Filter • e Stream • Tab Views • q Quit ";
  }
  return " ↑↓ Move • l Right pane • Enter Run • Tab Views • / Palette • ? Help • q Quit ";
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

const WELCOME_LINES = [
  "Welcome to xint intelligence console",
  "",
  "Quick start:",
  "  1 or Enter  Search tweets by keyword",
  "  2           View trending topics",
  "  3           Inspect a user profile",
  "  4           Expand a tweet thread",
  "  5           Fetch article content",
  "  /           Open command palette",
  "",
  "Use Up/Down to navigate, Tab to switch panes.",
];

function outputViewLines(session: SessionState, uiState: UiState, viewport: number): string[] {
  const phase = resolveUiPhase(session, uiState);
  const source = uiState.showStderr ? session.lastStderrLines : session.lastStdoutLines;
  const streamName = uiState.showStderr ? "stderr" : "stdout";
  const q = uiState.outputSearch.trim().toLowerCase();
  const filtered =
    q.length === 0 ? source : source.filter((line) => line.toLowerCase().includes(q));

  const visible = Math.max(1, viewport);
  const maxOffset = Math.max(0, filtered.length - visible);
  uiState.outputOffset = Math.min(uiState.outputOffset, maxOffset);

  const start = Math.max(0, filtered.length - visible - uiState.outputOffset);
  const end = Math.max(start, Math.min(filtered.length, start + visible));
  const windowLines = filtered.slice(start, end);

  // Welcome state: no output yet and idle
  if (phase === "IDLE" && session.lastOutputLines.length === 0 && !session.lastCommand) {
    const lines: string[] = [...WELCOME_LINES];
    if (uiState.inlinePromptLabel) {
      lines.push("");
      lines.push(uiState.inlinePromptLabel);
      lines.push(`> ${(uiState.inlinePromptValue ?? "")}█`);
    }
    return lines;
  }

  const lines: string[] = [
    "Last run",
    "",
    `phase: ${phaseBadge(phase)}`,
    `command: ${session.lastCommand ?? "-"}`,
    `status: ${session.lastStatus ?? "-"}`,
    `stream: ${streamName} (${source.length}) | stdout=${session.lastStdoutLines.length} stderr=${session.lastStderrLines.length}`,
    `filter: ${uiState.outputSearch || "(none)"}`,
    "",
  ];

  // Error state: show last error prominently
  if (phase === "ERROR" && session.lastError) {
    lines.push("!! ERROR !!");
    lines.push("");
    lines.push(session.lastError);
    lines.push("");
    lines.push("output:");
  } else {
    lines.push("output:");
  }

  if (uiState.inlinePromptLabel) {
    lines.push("");
    lines.push(uiState.inlinePromptLabel);
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
    return buildContextHelp(resolveUiPhase(session, uiState), uiState.tab, activeLayout());
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
    ` ${phaseBadge(phase)} ${selected.key}:${selected.label} | ${focus} | stream:${uiState.showStderr ? "stderr" : "stdout"} | ${status} `,
    Math.max(1, width),
  );
}

function renderDoublePane(uiState: UiState, session: SessionState, columns: number, rows: number): void {
  const theme = activeTheme();
  const border = activeBorderChars();
  const leftBoxWidth = Math.max(46, Math.floor(columns * 0.45));
  const rightBoxWidth = Math.max(30, columns - leftBoxWidth - 1);
  const leftInner = Math.max(20, leftBoxWidth - 2);
  const rightInner = Math.max(20, rightBoxWidth - 2);
  const totalRows = Math.max(12, rows - (isHeroEnabled() ? 10 : 9));

  const leftLines = buildMenuLines(uiState.activeIndex);
  const rightLines = buildTabLines(session, uiState, totalRows).slice(-totalRows);
  const tabs = buildTabs(uiState);
  const tracker = buildHeaderTracker(uiState, 16);

  let frame = `${theme.border}${border.tl}${border.h.repeat(Math.max(1, columns - 2))}${border.tr}${theme.reset}\n`;
  if (isHeroEnabled()) {
    frame += `${theme.border}${border.v}${theme.reset}${theme.hero}${buildHeroLine(uiState, session, Math.max(1, columns - 2))}${theme.reset}${theme.border}${border.v}${theme.reset}\n`;
  }
  frame += `${theme.border}${border.v}${theme.reset}${padText(` xint dashboard ${tabs}`, Math.max(1, columns - 2))}${theme.border}${border.v}${theme.reset}\n`;
  frame += `${theme.border}${border.v}${theme.reset}${theme.accent}${padText(` ${tracker}`, Math.max(1, columns - 2))}${theme.reset}${theme.border}${border.v}${theme.reset}\n`;
  const leftHeaderColor = uiState.focusedPane === "left" ? theme.accent : theme.muted;
  const rightHeaderColor = uiState.focusedPane === "right" ? theme.accent : theme.muted;
  const leftBorderColor = uiState.focusedPane === "left" ? theme.accent : theme.border;
  const rightBorderColor = uiState.focusedPane === "right" ? theme.accent : theme.border;

  frame += `${leftBorderColor}${border.lj}${border.h.repeat(leftBoxWidth - 2)}${border.rj}${theme.reset} ${rightBorderColor}${border.lj}${border.h.repeat(rightBoxWidth - 2)}${border.rj}${theme.reset}\n`;
  frame += `${leftBorderColor}${border.v}${theme.reset}${leftHeaderColor}${padText(" Commands", leftInner)}${theme.reset}${leftBorderColor}${border.v}${theme.reset} ${rightBorderColor}${border.v}${theme.reset}${rightHeaderColor}${padText(` ${tabLabel(uiState.tab)}`, rightInner)}${theme.reset}${rightBorderColor}${border.v}${theme.reset}\n`;
  frame += `${leftBorderColor}${border.lj}${border.h.repeat(leftBoxWidth - 2)}${border.rj}${theme.reset} ${rightBorderColor}${border.lj}${border.h.repeat(rightBoxWidth - 2)}${border.rj}${theme.reset}\n`;

  for (let row = 0; row < totalRows; row += 1) {
    const leftRaw = leftLines[row] ?? "";
    const rightRaw = rightLines[row] ?? "";
    const leftText = padText(leftRaw, leftInner);
    const rightText = padText(rightRaw, rightInner);
    const leftSegment = leftRaw.startsWith("> ")
      ? `${theme.accent}${leftText}${theme.reset}`
      : `${theme.muted}${leftText}${theme.reset}`;

    frame += `${leftBorderColor}${border.v}${theme.reset}${leftSegment}${leftBorderColor}${border.v}${theme.reset} ${rightBorderColor}${border.v}${theme.reset}${theme.muted}${rightText}${theme.reset}${rightBorderColor}${border.v}${theme.reset}\n`;
  }

  frame += `${leftBorderColor}${border.lj}${border.h.repeat(leftBoxWidth - 2)}${border.rj}${theme.reset} ${rightBorderColor}${border.lj}${border.h.repeat(rightBoxWidth - 2)}${border.rj}${theme.reset}\n`;
  frame += `${theme.border}${border.v}${theme.reset}${theme.accent}${buildStatusLine(session, uiState, Math.max(1, columns - 2))}${theme.reset}${theme.border}${border.v}${theme.reset}\n`;
  const footer = buildContextualFooter(resolveUiPhase(session, uiState), uiState);
  frame += `${theme.border}${border.v}${theme.reset}${padText(footer, Math.max(1, columns - 2))}${theme.border}${border.v}${theme.reset}\n`;
  frame += `${theme.border}${border.bl}${border.h.repeat(Math.max(1, columns - 2))}${border.br}${theme.reset}`;
  writeFrame(frame.split("\n"));
}

function renderSinglePane(uiState: UiState, session: SessionState, columns: number, rows: number): void {
  const theme = activeTheme();
  const border = activeBorderChars();
  const width = Math.max(30, columns - 2);
  const totalRows = Math.max(10, rows - (isHeroEnabled() ? 9 : 8));
  const tabs = buildTabs(uiState);
  const tracker = buildHeaderTracker(uiState, 16);

  const lines =
    uiState.tab === "commands"
      ? [...buildMenuLines(uiState.activeIndex), "", ...buildCommandDrawer(uiState.activeIndex)]
      : buildTabLines(session, uiState, totalRows * 2);

  let frame = `${theme.border}${border.tl}${border.h.repeat(width)}${border.tr}${theme.reset}\n`;
  if (isHeroEnabled()) {
    frame += `${theme.border}${border.v}${theme.reset}${theme.hero}${buildHeroLine(uiState, session, width)}${theme.reset}${theme.border}${border.v}${theme.reset}\n`;
  }
  frame += `${theme.border}${border.v}${theme.reset}${padText(` xint dashboard ${tabs}`, width)}${theme.border}${border.v}${theme.reset}\n`;
  frame += `${theme.border}${border.v}${theme.reset}${theme.accent}${padText(` ${tracker}`, width)}${theme.reset}${theme.border}${border.v}${theme.reset}\n`;
  frame += `${theme.border}${border.lj}${border.h.repeat(width)}${border.rj}${theme.reset}\n`;
  frame += `${theme.border}${border.v}${theme.reset}${theme.accent}${padText(` ${tabLabel(uiState.tab)}`, width)}${theme.reset}${theme.border}${border.v}${theme.reset}\n`;
  frame += `${theme.border}${border.lj}${border.h.repeat(width)}${border.rj}${theme.reset}\n`;

  for (const line of lines.slice(-totalRows)) {
    const row = padText(line, width);
    if (line.startsWith("> ")) {
      frame += `${theme.border}${border.v}${theme.reset}${theme.accent}${row}${theme.reset}${theme.border}${border.v}${theme.reset}\n`;
    } else {
      frame += `${theme.border}${border.v}${theme.reset}${theme.muted}${row}${theme.reset}${theme.border}${border.v}${theme.reset}\n`;
    }
  }

  const rendered = Math.min(totalRows, lines.length);
  for (let i = rendered; i < totalRows; i += 1) {
    frame += `${theme.border}${border.v}${theme.reset}${" ".repeat(width)}${theme.border}${border.v}${theme.reset}\n`;
  }

  const footer = buildContextualFooter(resolveUiPhase(session, uiState), uiState);
  frame += `${theme.border}${border.lj}${border.h.repeat(width)}${border.rj}${theme.reset}\n`;
  frame += `${theme.border}${border.v}${theme.reset}${theme.accent}${buildStatusLine(session, uiState, width)}${theme.reset}${theme.border}${border.v}${theme.reset}\n`;
  frame += `${theme.border}${border.lj}${border.h.repeat(width)}${border.rj}${theme.reset}\n`;
  frame += `${theme.border}${border.v}${theme.reset}${padText(footer, width)}${theme.border}${border.v}${theme.reset}\n`;
  frame += `${theme.border}${border.bl}${border.h.repeat(width)}${border.br}${theme.reset}`;
  writeFrame(frame.split("\n"));
}

function renderFocusPane(uiState: UiState, session: SessionState, columns: number, rows: number): void {
  const theme = activeTheme();
  const border = activeBorderChars();
  const width = Math.max(30, columns - 2);
  const totalRows = Math.max(10, rows - 5);

  const lines = outputViewLines(session, uiState, totalRows * 2);

  let frame = `${theme.border}${border.tl}${border.h.repeat(width)}${border.tr}${theme.reset}\n`;
  frame += `${theme.border}${border.v}${theme.reset}${theme.accent}${padText(" xint [focus] | / Palette | q Quit", width)}${theme.reset}${theme.border}${border.v}${theme.reset}\n`;
  frame += `${theme.border}${border.lj}${border.h.repeat(width)}${border.rj}${theme.reset}\n`;

  for (const line of lines.slice(-totalRows)) {
    const row = padText(line, width);
    frame += `${theme.border}${border.v}${theme.reset}${theme.muted}${row}${theme.reset}${theme.border}${border.v}${theme.reset}\n`;
  }

  const rendered = Math.min(totalRows, lines.length);
  for (let i = rendered; i < totalRows; i += 1) {
    frame += `${theme.border}${border.v}${theme.reset}${" ".repeat(width)}${theme.border}${border.v}${theme.reset}\n`;
  }

  frame += `${theme.border}${border.lj}${border.h.repeat(width)}${border.rj}${theme.reset}\n`;
  frame += `${theme.border}${border.v}${theme.reset}${theme.accent}${buildStatusLine(session, uiState, width)}${theme.reset}${theme.border}${border.v}${theme.reset}\n`;
  frame += `${theme.border}${border.bl}${border.h.repeat(width)}${border.br}${theme.reset}`;
  writeFrame(frame.split("\n"));
}

let previousFrameLines: string[] = [];

function writeFrame(lines: string[]): void {
  // Synchronized Output protocol: buffer the entire frame atomically
  let buf = "\x1b[?2026h"; // begin synchronized update

  if (previousFrameLines.length === 0) {
    // First frame: full clear + write
    buf += "\x1b[2J\x1b[H";
    buf += lines.join("\n") + "\n";
  } else {
    // Dirty-region rendering: only rewrite changed lines
    const maxLines = Math.max(previousFrameLines.length, lines.length);
    for (let i = 0; i < maxLines; i++) {
      const prev = previousFrameLines[i] ?? "";
      const next = lines[i] ?? "";
      if (prev !== next) {
        buf += `\x1b[${i + 1};1H`; // move cursor to row i+1, col 1
        buf += next;
        buf += "\x1b[K"; // always clear to EOL — byte-length is unreliable with embedded ANSI
      }
    }
    // If previous frame had more lines, clear them
    if (previousFrameLines.length > lines.length) {
      for (let i = lines.length; i < previousFrameLines.length; i++) {
        buf += `\x1b[${i + 1};1H\x1b[K`;
      }
    }
  }

  buf += "\x1b[?2026l"; // end synchronized update
  previousFrameLines = lines;
  output.write(buf);
}

function renderDashboard(uiState: UiState, session: SessionState): void {
  const columns = output.columns ?? 120;
  const rows = output.rows ?? 32;
  const layout = activeLayout();

  if (layout === "focus") {
    renderFocusPane(uiState, session, columns, rows);
  } else if (layout === "compact" || columns < 110) {
    renderSinglePane(uiState, session, columns, rows);
  } else {
    renderDoublePane(uiState, session, columns, rows);
  }
}

function applyMenuKeyEvent(
  str: string | undefined,
  key: KeypressLike,
  uiState: UiState,
): { resolve?: string } {
  if (key.ctrl && key.name === "c") return { resolve: "0" };

  if (key.name === "up") {
    uiState.activeIndex = (uiState.activeIndex - 1 + INTERACTIVE_ACTIONS.length) % INTERACTIVE_ACTIONS.length;
    if (uiState.tab !== "commands") uiState.tab = "commands";
    return {};
  }
  if (key.name === "down") {
    uiState.activeIndex = (uiState.activeIndex + 1) % INTERACTIVE_ACTIONS.length;
    if (uiState.tab !== "commands") uiState.tab = "commands";
    return {};
  }
  if (key.name === "tab") {
    uiState.tab = nextTab(uiState.tab);
    return {};
  }
  if (str === "h" && activeLayout() === "full") {
    uiState.focusedPane = "left";
    return {};
  }
  if (str === "l" && activeLayout() === "full") {
    uiState.focusedPane = "right";
    return {};
  }
  if (key.name === "pageup") {
    uiState.tab = "output";
    uiState.outputOffset += 10;
    return {};
  }
  if (key.name === "pagedown") {
    uiState.tab = "output";
    uiState.outputOffset = Math.max(0, uiState.outputOffset - 10);
    return {};
  }
  if (key.name === "return") {
    const selected = INTERACTIVE_ACTIONS[uiState.activeIndex];
    uiState.tab = "output";
    return { resolve: selected?.key ?? "0" };
  }
  if (key.name === "escape" || str === "q") return { resolve: "0" };
  if (str === "?") {
    uiState.tab = "help";
    return {};
  }
  if (str === "1") {
    uiState.tab = "commands";
    return {};
  }
  if (str === "2") {
    uiState.tab = "output";
    return {};
  }
  if (str === "3") {
    uiState.tab = "help";
    return {};
  }
  if (str?.toLowerCase() === "f") {
    uiState.tab = "output";
    return { resolve: "__filter__" };
  }
  if (str?.toLowerCase() === "e") {
    uiState.tab = "output";
    uiState.showStderr = !uiState.showStderr;
    uiState.outputOffset = 0;
    return {};
  }
  if (str === "/") {
    uiState.tab = "output";
    return { resolve: "__palette__" };
  }

  const normalized = normalizeInteractiveChoice(typeof str === "string" ? str : "");
  if (normalized) {
    uiState.tab = "output";
    return { resolve: normalized };
  }
  return {};
}

function applyPromptKeyEvent(
  str: string | undefined,
  key: KeypressLike,
  uiState: UiState,
  historyStore?: HistoryStore,
): { resolve?: string } {
  if (key.ctrl && key.name === "c") return { resolve: "" };
  if (key.name === "escape") return { resolve: "" };
  if (key.name === "return") return { resolve: uiState.inlinePromptValue ?? "" };
  if (key.name === "backspace") {
    uiState.inlinePromptValue = (uiState.inlinePromptValue ?? "").slice(0, -1);
    uiState.historyCursor = -1;
    return {};
  }
  if (key.name === "up" && historyStore && uiState.historyCategory) {
    const entries = historyForCategory(historyStore, uiState.historyCategory);
    if (entries.length > 0) {
      if (uiState.historyCursor === -1) {
        uiState.historyDraft = uiState.inlinePromptValue ?? "";
      }
      const next = Math.min(uiState.historyCursor + 1, entries.length - 1);
      uiState.historyCursor = next;
      uiState.inlinePromptValue = entries[entries.length - 1 - next];
    }
    return {};
  }
  if (key.name === "down" && historyStore && uiState.historyCategory) {
    if (uiState.historyCursor > 0) {
      const entries = historyForCategory(historyStore, uiState.historyCategory);
      uiState.historyCursor -= 1;
      uiState.inlinePromptValue = entries[entries.length - 1 - uiState.historyCursor];
    } else if (uiState.historyCursor === 0) {
      uiState.historyCursor = -1;
      uiState.inlinePromptValue = uiState.historyDraft ?? "";
    }
    return {};
  }
  if (typeof str === "string" && str.length > 0 && !key.ctrl) {
    uiState.inlinePromptValue = `${uiState.inlinePromptValue ?? ""}${str}`;
    uiState.historyCursor = -1;
  }
  return {};
}

function applyRunEvent(event: RunEvent, session: SessionState): string | null {
  if (event.type === "tick") {
    session.lastStatus = `running ${event.spinner}`;
    return null;
  }
  const status = event.code === 0 ? "success" : `failed (exit ${event.code})`;
  session.lastStatus = status;
  return status;
}

async function selectOption(
  rl: ReturnType<typeof createInterface> | null,
  session: SessionState,
  uiState: UiState,
  requestRender: () => void,
): Promise<string> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    if (!rl) throw new Error("readline interface is unavailable");
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
    };

    const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      const { resolve: resolved } = applyMenuKeyEvent(str, key, uiState);
      if (resolved) {
        cleanup();
        resolve(resolved);
        return;
      }
      requestRender();
    };

    input.resume();
    input.on("keypress", onKeypress);
    requestRender();
  });
}

function appendOutput(session: SessionState, line: string, stream: "stdout" | "stderr" = "stdout"): void {
  const trimmed = sanitizeOutputLine(line).trimEnd();
  if (!trimmed) return;
  if (stream === "stderr") {
    session.lastStderrLines.push(trimmed);
    if (session.lastStderrLines.length > 1200) {
      session.lastStderrLines = session.lastStderrLines.slice(-1200);
    }
  } else {
    session.lastStdoutLines.push(trimmed);
    if (session.lastStdoutLines.length > 1200) {
      session.lastStdoutLines = session.lastStdoutLines.slice(-1200);
    }
  }
  session.lastOutputLines.push(trimmed);
  if (session.lastOutputLines.length > 1200) {
    session.lastOutputLines = session.lastOutputLines.slice(-1200);
  }
}

async function consumeStream(
  stream: ReadableStream<Uint8Array> | null,
  prefix: string,
  onLine: (line: string) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Split on \n (handles \r\n via split). Defer trailing \r to next
    // chunk to avoid false split when \r\n spans chunk boundaries.
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const cleaned = part.replace(/\r/g, "");
      onLine(prefix ? `[${prefix}] ${cleaned}` : cleaned);
    }
  }

  const remaining = buffer.replace(/\r/g, "").trim();
  if (remaining.length > 0) {
    onLine(prefix ? `[${prefix}] ${remaining}` : remaining);
  }
}

async function runSubcommand(
  args: string[],
  session: SessionState,
  uiState: UiState,
  requestRender: () => void,
): Promise<{ status: string; outputLines: string[] }> {
  const scriptPath = join(import.meta.dir, "..", "xint.ts");
  const proc = Bun.spawn({
    cmd: [process.execPath, scriptPath, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  session.lastOutputLines = [];
  session.lastStdoutLines = [];
  session.lastStderrLines = [];
  uiState.outputOffset = 0;
  let spinnerIndex = 0;
  let finalStatus: string | null = null;
  const dispatch = (event: RunEvent) => {
    const status = applyRunEvent(event, session);
    if (status) finalStatus = status;
    if (input.isTTY && output.isTTY) {
      requestRender();
    }
  };

  const spinner = setInterval(() => {
    dispatch({ type: "tick", spinner: SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length] });
    spinnerIndex += 1;
  }, 90);

  const stdoutTask = consumeStream(proc.stdout ?? null, "", (line) => {
    appendOutput(session, line, "stdout");
    if (input.isTTY && output.isTTY) requestRender();
  });
  const stderrTask = consumeStream(proc.stderr ?? null, "stderr", (line) => {
    appendOutput(session, line, "stderr");
    if (input.isTTY && output.isTTY) requestRender();
  });

  const exitCode = await proc.exited;
  await Promise.all([stdoutTask, stderrTask]);
  clearInterval(spinner);
  dispatch({ type: "exit", code: exitCode });
  const status = finalStatus ?? (exitCode === 0 ? "success" : `failed (exit ${exitCode})`);
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
  rl: ReturnType<typeof createInterface> | null,
  label: string,
  uiState: UiState,
  session: SessionState,
  requestRender: () => void,
  historyStore?: HistoryStore,
  historyCategory?: string,
): Promise<string> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    if (!rl) throw new Error("readline interface is unavailable");
    return await rl.question(`\n${label}`);
  }

  emitKeypressEvents(input);
  uiState.tab = "output";
  uiState.inlinePromptLabel = label;
  uiState.inlinePromptValue = "";
  uiState.historyCategory = historyCategory;
  uiState.historyCursor = -1;
  uiState.historyDraft = undefined;
  requestRender();

  return await new Promise<string>((resolve) => {
    const cleanup = () => {
      input.off("keypress", onKeypress);
      uiState.inlinePromptLabel = undefined;
      uiState.inlinePromptValue = undefined;
      uiState.historyCategory = undefined;
      uiState.historyCursor = -1;
      uiState.historyDraft = undefined;
      requestRender();
    };

    const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      const { resolve: resolved } = applyPromptKeyEvent(str, key, uiState, historyStore);
      if (resolved !== undefined) {
        cleanup();
        resolve(resolved);
        return;
      }
      requestRender();
    };

    input.resume();
    input.on("keypress", onKeypress);
  });
}

export async function cmdTui(): Promise<void> {
  const useRawTui = input.isTTY && output.isTTY && typeof input.setRawMode === "function";
  previousFrameLines = []; // reset from any previous cmdTui() invocation
  const frameIntervalMs = 33;
  let scheduledRender: ReturnType<typeof setTimeout> | null = null;
  let lastRenderAt = 0;
  const initialIndex = INTERACTIVE_ACTIONS.findIndex((option) => option.key === "1");
  const uiState: UiState = {
    activeIndex: initialIndex >= 0 ? initialIndex : 0,
    tab: "commands",
    outputOffset: 0,
    outputSearch: "",
    showStderr: false,
    focusedPane: "left",
    historyCursor: -1,
  };
  const session: SessionState = {
    lastStdoutLines: [],
    lastStderrLines: [],
    lastOutputLines: [],
  };
  const historyStore = loadHistory();
  const requestRender = (force = false) => {
    if (!useRawTui) return;
    const now = Date.now();
    const elapsed = now - lastRenderAt;
    if (force || elapsed >= frameIntervalMs) {
      if (scheduledRender) {
        clearTimeout(scheduledRender);
        scheduledRender = null;
      }
      lastRenderAt = now;
      renderDashboard(uiState, session);
      return;
    }
    if (scheduledRender) return;
    scheduledRender = setTimeout(() => {
      scheduledRender = null;
      lastRenderAt = Date.now();
      renderDashboard(uiState, session);
    }, frameIntervalMs - elapsed);
  };
  const onResize = () => {
    previousFrameLines = []; // force full redraw on terminal resize
    requestRender(true);
  };
  const rl = useRawTui ? null : createInterface({ input, output });

  try {
    if (useRawTui) {
      emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      output.write("\x1b[?1049h\x1b[?25l");
      output.on("resize", onResize);
    }

    for (;;) {
      let choice = await selectOption(rl, session, uiState, () => requestRender());
      if (choice === "0") {
        break;
      }
      if (choice === "__filter__") {
        const query = await questionInDashboard(
          rl,
          "Output search (blank clears): ",
          uiState,
          session,
          () => requestRender(),
          historyStore,
          "filter",
        );
        requestRender(true);
        uiState.outputSearch = query.trim();
        uiState.outputOffset = 0;
        uiState.tab = "output";
        session.lastStatus = uiState.outputSearch
          ? `output filter active: ${uiState.outputSearch}`
          : "output filter cleared";
        continue;
      }
      if (choice === "__palette__") {
        const query = await questionInDashboard(rl, "Palette (/): ", uiState, session, () => requestRender(), historyStore, "palette");
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
        session.lastError = undefined;
        switch (choice) {
          case "1": {
            const query = requireInput(
              promptWithDefault(
                await questionInDashboard(
                  rl,
                  `Search query${session.lastSearch ? ` [${session.lastSearch}]` : ""}: `,
                  uiState,
                  session,
                  () => requestRender(),
                  historyStore,
                  "search",
                ),
                session.lastSearch,
              ),
              "Query",
            );
            session.lastSearch = query;
            pushHistory(historyStore, "search", query);
            saveHistory(historyStore);
            const planResult = buildTuiExecutionPlan(choice, query);
            if (planResult.type === "error" || !planResult.data) throw new Error(planResult.message);
            session.lastCommand = planResult.data.command;
            const result = await runSubcommand(planResult.data.args, session, uiState, () => requestRender());
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
                  () => requestRender(),
                  historyStore,
                  "location",
                ),
              session.lastLocation,
            );
            if (location) session.lastLocation = location;
            pushHistory(historyStore, "location", location);
            saveHistory(historyStore);
            const planResult = buildTuiExecutionPlan(choice, location);
            if (planResult.type === "error" || !planResult.data) throw new Error(planResult.message);
            session.lastCommand = planResult.data.command;
            const result = await runSubcommand(planResult.data.args, session, uiState, () => requestRender());
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
                  () => requestRender(),
                  historyStore,
                  "username",
                ),
                session.lastUsername,
              ),
              "Username",
            ).replace(/^@/, "");
            session.lastUsername = username;
            pushHistory(historyStore, "username", username);
            saveHistory(historyStore);
            const planResult = buildTuiExecutionPlan(choice, username);
            if (planResult.type === "error" || !planResult.data) throw new Error(planResult.message);
            session.lastCommand = planResult.data.command;
            const result = await runSubcommand(planResult.data.args, session, uiState, () => requestRender());
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
                  () => requestRender(),
                  historyStore,
                  "tweet",
                ),
                session.lastTweetRef,
              ),
              "Tweet ID/URL",
            );
            session.lastTweetRef = tweetRef;
            pushHistory(historyStore, "tweet", tweetRef);
            saveHistory(historyStore);
            const planResult = buildTuiExecutionPlan(choice, tweetRef);
            if (planResult.type === "error" || !planResult.data) throw new Error(planResult.message);
            session.lastCommand = planResult.data.command;
            const result = await runSubcommand(planResult.data.args, session, uiState, () => requestRender());
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
                  () => requestRender(),
                  historyStore,
                  "article",
                ),
                session.lastArticleUrl,
              ),
              "Article URL",
            );
            session.lastArticleUrl = url;
            pushHistory(historyStore, "article", url);
            saveHistory(historyStore);
            const planResult = buildTuiExecutionPlan(choice, url);
            if (planResult.type === "error" || !planResult.data) throw new Error(planResult.message);
            session.lastCommand = planResult.data.command;
            const result = await runSubcommand(planResult.data.args, session, uiState, () => requestRender());
            session.lastStatus = result.status;
            session.lastOutputLines = result.outputLines;
            break;
          }
          case "6": {
            const planResult = buildTuiExecutionPlan(choice);
            if (planResult.type === "error" || !planResult.data) throw new Error(planResult.message);
            session.lastCommand = planResult.data.command;
            const result = await runSubcommand(planResult.data.args, session, uiState, () => requestRender());
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
        session.lastError = message;
      }
    }
  } finally {
    if (useRawTui) {
      if (scheduledRender) clearTimeout(scheduledRender);
      output.off("resize", onResize);
      input.setRawMode(false);
      output.write("\x1b[?25h\x1b[?1049l");
    }
    rl?.close();
  }
}

export const __tuiTestUtils = {
  applyMenuKeyEvent,
  applyPromptKeyEvent,
  outputViewLines,
  sanitizeOutputLine,
  loadHistory,
  saveHistory,
  pushHistory,
  historyForCategory,
  activeLayout,
  buildContextualFooter,
  buildContextHelp,
  buildTabLines,
  HISTORY_FILE,
  WELCOME_LINES,
};
