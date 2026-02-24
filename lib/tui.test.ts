import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { __tuiTestUtils } from "./tui";
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";

function makeUiState(overrides?: Record<string, unknown>) {
  return {
    activeIndex: 0,
    tab: "commands" as const,
    outputOffset: 0,
    outputSearch: "",
    showStderr: false,
    focusedPane: "left" as const,
    historyCursor: -1,
    ...overrides,
  };
}

function makeSession(overrides?: Record<string, unknown>) {
  return {
    lastStdoutLines: [] as string[],
    lastStderrLines: [] as string[],
    lastOutputLines: [] as string[],
    ...overrides,
  };
}

describe("tui helpers", () => {
  test("sanitizeOutputLine removes ANSI and control sequences", () => {
    const line = "\x1b[31merror\x1b[0m\x1b]0;title\x07\r";
    expect(__tuiTestUtils.sanitizeOutputLine(line)).toBe("error");
  });

  test("applyMenuKeyEvent toggles stderr stream view", () => {
    const uiState = makeUiState({ tab: "commands", outputOffset: 2 });

    const result = __tuiTestUtils.applyMenuKeyEvent("e", {}, uiState);
    expect(result.resolve).toBeUndefined();
    expect(uiState.tab).toBe("output");
    expect(uiState.showStderr).toBe(true);
    expect(uiState.outputOffset).toBe(0);
  });

  test("outputViewLines reads selected stream", () => {
    const session = makeSession({
      lastCommand: "xint search ai",
      lastStatus: "success",
      lastStdoutLines: ["[stdout] ok 1", "[stdout] ok 2"],
      lastStderrLines: ["[stderr] warning"],
      lastOutputLines: ["[stdout] ok 1", "[stdout] ok 2", "[stderr] warning"],
    });

    const uiState = makeUiState();

    const stdoutLines = __tuiTestUtils.outputViewLines(session, uiState, 10).join("\n");
    expect(stdoutLines).toContain("stream: stdout (2)");
    expect(stdoutLines).toContain("[stdout] ok 2");
    expect(stdoutLines).not.toContain("[stderr] warning");

    uiState.showStderr = true;
    const stderrLines = __tuiTestUtils.outputViewLines(session, uiState, 10).join("\n");
    expect(stderrLines).toContain("stream: stderr (1)");
    expect(stderrLines).toContain("[stderr] warning");
    expect(stderrLines).not.toContain("[stdout] ok 2");
  });
});

describe("tui history", () => {
  const testHistoryFile = join(dirname(__tuiTestUtils.HISTORY_FILE), "tui-history-test.json");

  beforeEach(() => {
    if (existsSync(testHistoryFile)) unlinkSync(testHistoryFile);
  });

  afterEach(() => {
    if (existsSync(testHistoryFile)) unlinkSync(testHistoryFile);
  });

  test("pushHistory adds entries and deduplicates", () => {
    const store: Record<string, string[]> = {};
    __tuiTestUtils.pushHistory(store, "search", "ai agents");
    __tuiTestUtils.pushHistory(store, "search", "bitcoin");
    __tuiTestUtils.pushHistory(store, "search", "ai agents"); // move to end

    expect(store.search).toEqual(["bitcoin", "ai agents"]);
  });

  test("pushHistory enforces max entries", () => {
    const store: Record<string, string[]> = {};
    for (let i = 0; i < 60; i++) {
      __tuiTestUtils.pushHistory(store, "search", `query-${i}`);
    }
    expect(store.search!.length).toBe(50);
    expect(store.search![49]).toBe("query-59");
    expect(store.search![0]).toBe("query-10");
  });

  test("pushHistory ignores blank values", () => {
    const store: Record<string, string[]> = {};
    __tuiTestUtils.pushHistory(store, "search", "");
    __tuiTestUtils.pushHistory(store, "search", "   ");
    expect(store.search).toBeUndefined();
  });

  test("historyForCategory returns entries or empty array", () => {
    const store = { search: ["a", "b"] };
    expect(__tuiTestUtils.historyForCategory(store, "search")).toEqual(["a", "b"]);
    expect(__tuiTestUtils.historyForCategory(store, "username")).toEqual([]);
  });

  test("saveHistory and loadHistory round-trip", () => {
    const dir = dirname(__tuiTestUtils.HISTORY_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const store = { search: ["hello", "world"], username: ["nyk"] };
    writeFileSync(__tuiTestUtils.HISTORY_FILE, JSON.stringify(store), "utf8");

    const loaded = __tuiTestUtils.loadHistory();
    expect(loaded.search).toEqual(["hello", "world"]);
    expect(loaded.username).toEqual(["nyk"]);

    // Clean up
    if (existsSync(__tuiTestUtils.HISTORY_FILE)) unlinkSync(__tuiTestUtils.HISTORY_FILE);
  });

  test("applyPromptKeyEvent navigates history with Up/Down", () => {
    const store = { search: ["first", "second", "third"] };
    const uiState = makeUiState({
      inlinePromptLabel: "Search: ",
      inlinePromptValue: "current",
      historyCategory: "search",
      historyCursor: -1,
    });

    // Up -> most recent entry ("third")
    __tuiTestUtils.applyPromptKeyEvent(undefined, { name: "up" }, uiState, store);
    expect(uiState.inlinePromptValue).toBe("third");
    expect(uiState.historyCursor).toBe(0);
    expect(uiState.historyDraft).toBe("current");

    // Up again -> "second"
    __tuiTestUtils.applyPromptKeyEvent(undefined, { name: "up" }, uiState, store);
    expect(uiState.inlinePromptValue).toBe("second");
    expect(uiState.historyCursor).toBe(1);

    // Down -> back to "third"
    __tuiTestUtils.applyPromptKeyEvent(undefined, { name: "down" }, uiState, store);
    expect(uiState.inlinePromptValue).toBe("third");
    expect(uiState.historyCursor).toBe(0);

    // Down again -> back to draft
    __tuiTestUtils.applyPromptKeyEvent(undefined, { name: "down" }, uiState, store);
    expect(uiState.inlinePromptValue).toBe("current");
    expect(uiState.historyCursor).toBe(-1);
  });
});

describe("tui empty/error states", () => {
  test("outputViewLines shows welcome when idle with no output", () => {
    const session = makeSession();
    const uiState = makeUiState();
    const lines = __tuiTestUtils.outputViewLines(session, uiState, 20);
    const text = lines.join("\n");
    expect(text).toContain("Welcome to xint intelligence console");
    expect(text).toContain("Quick start:");
  });

  test("outputViewLines shows regular output when command has run", () => {
    const session = makeSession({
      lastCommand: "xint search ai",
      lastStatus: "success",
      lastStdoutLines: ["result 1"],
      lastOutputLines: ["result 1"],
    });
    const uiState = makeUiState();
    const lines = __tuiTestUtils.outputViewLines(session, uiState, 20);
    const text = lines.join("\n");
    expect(text).not.toContain("Welcome");
    expect(text).toContain("result 1");
  });

  test("outputViewLines shows error prominently when phase is ERROR", () => {
    const session = makeSession({
      lastCommand: "xint search",
      lastStatus: "error: Query is required",
      lastError: "Query is required",
      lastStdoutLines: [],
      lastOutputLines: [],
    });
    const uiState = makeUiState();
    const lines = __tuiTestUtils.outputViewLines(session, uiState, 20);
    const text = lines.join("\n");
    expect(text).toContain("!! ERROR !!");
    expect(text).toContain("Query is required");
  });
});

describe("tui focused pane and h/l navigation", () => {
  const originalLayout = process.env.XINT_TUI_LAYOUT;

  afterEach(() => {
    if (originalLayout !== undefined) {
      process.env.XINT_TUI_LAYOUT = originalLayout;
    } else {
      delete process.env.XINT_TUI_LAYOUT;
    }
  });

  test("h key sets focusedPane to left in full layout", () => {
    delete process.env.XINT_TUI_LAYOUT;
    const uiState = makeUiState({ focusedPane: "right" });
    __tuiTestUtils.applyMenuKeyEvent("h", {}, uiState);
    expect(uiState.focusedPane).toBe("left");
  });

  test("l key sets focusedPane to right in full layout", () => {
    delete process.env.XINT_TUI_LAYOUT;
    const uiState = makeUiState({ focusedPane: "left" });
    __tuiTestUtils.applyMenuKeyEvent("l", {}, uiState);
    expect(uiState.focusedPane).toBe("right");
  });

  test("h key falls through to Help alias in compact layout", () => {
    process.env.XINT_TUI_LAYOUT = "compact";
    const uiState = makeUiState({ focusedPane: "right" });
    const result = __tuiTestUtils.applyMenuKeyEvent("h", {}, uiState);
    // In compact, "h" is an alias for Help (key "6")
    expect(result.resolve).toBe("6");
    expect(uiState.focusedPane).toBe("right"); // unchanged
  });

  test("Up/Down auto-switches tab to commands", () => {
    const uiState = makeUiState({ tab: "output" });
    __tuiTestUtils.applyMenuKeyEvent(undefined, { name: "up" }, uiState);
    expect(uiState.tab).toBe("commands");
  });

  test("PgUp auto-switches to output tab", () => {
    const uiState = makeUiState({ tab: "commands" });
    __tuiTestUtils.applyMenuKeyEvent(undefined, { name: "pageup" }, uiState);
    expect(uiState.tab).toBe("output");
  });
});

describe("tui contextual footer", () => {
  test("returns prompt hints during INPUT phase", () => {
    const uiState = makeUiState();
    const footer = __tuiTestUtils.buildContextualFooter("INPUT", uiState);
    expect(footer).toContain("Submit");
    expect(footer).toContain("History");
    expect(footer).toContain("Cancel");
  });

  test("returns running hints during RUNNING phase", () => {
    const uiState = makeUiState();
    const footer = __tuiTestUtils.buildContextualFooter("RUNNING", uiState);
    expect(footer).toContain("Scroll");
    expect(footer).toContain("Waiting");
    expect(footer).not.toContain("Enter Run");
  });

  test("returns navigation hints during IDLE phase with left focus", () => {
    const uiState = makeUiState({ focusedPane: "left" });
    const footer = __tuiTestUtils.buildContextualFooter("IDLE", uiState);
    expect(footer).toContain("Move");
    expect(footer).toContain("Enter Run");
    expect(footer).toContain("Palette");
  });

  test("returns right-pane hints when focused right", () => {
    const uiState = makeUiState({ focusedPane: "right" });
    const footer = __tuiTestUtils.buildContextualFooter("IDLE", uiState);
    expect(footer).toContain("Left pane");
    expect(footer).toContain("Filter");
    expect(footer).not.toContain("Enter Run");
  });
});

describe("tui context-sensitive help", () => {
  test("shows prompt mode help during INPUT phase", () => {
    const help = __tuiTestUtils.buildContextHelp("INPUT", "help", "full");
    const text = help.join("\n");
    expect(text).toContain("Prompt mode");
    expect(text).toContain("Submit value");
    expect(text).toContain("Browse history");
  });

  test("shows running mode help during RUNNING phase", () => {
    const help = __tuiTestUtils.buildContextHelp("RUNNING", "help", "full");
    const text = help.join("\n");
    expect(text).toContain("Command running");
    expect(text).toContain("Scroll output");
  });

  test("shows navigation help during IDLE phase", () => {
    const help = __tuiTestUtils.buildContextHelp("IDLE", "help", "full");
    const text = help.join("\n");
    expect(text).toContain("Navigation");
    expect(text).toContain("h/l");
    expect(text).toContain("Command palette");
  });

  test("hides h/l hint for non-full layouts", () => {
    const help = __tuiTestUtils.buildContextHelp("IDLE", "help", "compact");
    const text = help.join("\n");
    expect(text).not.toContain("h/l");
  });

  test("marks active layout in presets section", () => {
    const help = __tuiTestUtils.buildContextHelp("IDLE", "help", "compact");
    const text = help.join("\n");
    expect(text).toContain("compact  Single-pane, no hero or tracker (active)");
  });
});

describe("tui buildTabLines auto-shows command details", () => {
  test("commands tab returns command drawer", () => {
    const session = makeSession();
    const uiState = makeUiState({ tab: "commands", activeIndex: 0 });
    const lines = __tuiTestUtils.buildTabLines(session, uiState, 20);
    const text = lines.join("\n");
    expect(text).toContain("Command details");
    expect(text).toContain("Selected:");
  });

  test("help tab returns context-sensitive help", () => {
    const session = makeSession();
    const uiState = makeUiState({ tab: "help" });
    const lines = __tuiTestUtils.buildTabLines(session, uiState, 20);
    const text = lines.join("\n");
    expect(text).toContain("Help");
    expect(text).toContain("Navigation");
  });
});

describe("tui layout presets", () => {
  const originalEnv = process.env.XINT_TUI_LAYOUT;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.XINT_TUI_LAYOUT = originalEnv;
    } else {
      delete process.env.XINT_TUI_LAYOUT;
    }
  });

  test("activeLayout returns full by default", () => {
    delete process.env.XINT_TUI_LAYOUT;
    expect(__tuiTestUtils.activeLayout()).toBe("full");
  });

  test("activeLayout returns compact when set", () => {
    process.env.XINT_TUI_LAYOUT = "compact";
    expect(__tuiTestUtils.activeLayout()).toBe("compact");
  });

  test("activeLayout returns focus when set", () => {
    process.env.XINT_TUI_LAYOUT = "focus";
    expect(__tuiTestUtils.activeLayout()).toBe("focus");
  });

  test("activeLayout defaults to full for unknown values", () => {
    process.env.XINT_TUI_LAYOUT = "nonsense";
    expect(__tuiTestUtils.activeLayout()).toBe("full");
  });
});
