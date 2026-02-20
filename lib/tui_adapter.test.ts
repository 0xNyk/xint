import { describe, expect, test } from "bun:test";
import { buildTuiExecutionPlan } from "./tui_adapter";

describe("tui adapter", () => {
  test("builds search plan", () => {
    const result = buildTuiExecutionPlan("1", "ai agents");
    expect(result.type).toBe("success");
    expect(result.data).toEqual({
      command: "xint search ai agents",
      args: ["search", "ai agents"],
    });
  });

  test("normalizes ampersand in search query", () => {
    const result = buildTuiExecutionPlan("1", "ai & solana");
    expect(result.type).toBe("success");
    expect(result.data).toEqual({
      command: "xint search ai AND solana",
      args: ["search", "ai AND solana"],
    });
  });

  test("builds trends plan with blank input", () => {
    const result = buildTuiExecutionPlan("2", "");
    expect(result.type).toBe("success");
    expect(result.data).toEqual({
      command: "xint trends",
      args: ["trends"],
    });
  });

  test("normalizes @ in profile", () => {
    const result = buildTuiExecutionPlan("3", "@nyk");
    expect(result.type).toBe("success");
    expect(result.data).toEqual({
      command: "xint profile nyk",
      args: ["profile", "nyk"],
    });
  });
});
