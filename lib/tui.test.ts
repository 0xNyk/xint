import { describe, expect, test } from "bun:test";
import { __tuiTestUtils } from "./tui";

describe("tui helpers", () => {
  test("sanitizeOutputLine removes ANSI and control sequences", () => {
    const line = "\x1b[31merror\x1b[0m\x1b]0;title\x07\r";
    expect(__tuiTestUtils.sanitizeOutputLine(line)).toBe("error");
  });

  test("applyMenuKeyEvent toggles stderr stream view", () => {
    const uiState = {
      activeIndex: 0,
      tab: "commands" as const,
      outputOffset: 2,
      outputSearch: "",
      showStderr: false,
    };

    const result = __tuiTestUtils.applyMenuKeyEvent("e", {}, uiState);
    expect(result.resolve).toBeUndefined();
    expect(uiState.tab).toBe("output");
    expect(uiState.showStderr).toBe(true);
    expect(uiState.outputOffset).toBe(0);
  });

  test("outputViewLines reads selected stream", () => {
    const session = {
      lastCommand: "xint search ai",
      lastStatus: "success",
      lastStdoutLines: ["[stdout] ok 1", "[stdout] ok 2"],
      lastStderrLines: ["[stderr] warning"],
      lastOutputLines: ["[stdout] ok 1", "[stdout] ok 2", "[stderr] warning"],
    };

    const uiState = {
      activeIndex: 0,
      tab: "output" as const,
      outputOffset: 0,
      outputSearch: "",
      showStderr: false,
    };

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
