import { describe, expect, test } from "bun:test";
import {
  INTERACTIVE_ACTIONS,
  normalizeInteractiveChoice,
  scoreInteractiveAction,
} from "./actions";

describe("interactive action registry", () => {
  test("normalizes key and alias inputs", () => {
    expect(normalizeInteractiveChoice("1")).toBe("1");
    expect(normalizeInteractiveChoice("search")).toBe("1");
    expect(normalizeInteractiveChoice("Q")).toBe("0");
  });

  test("rejects unknown choices", () => {
    expect(normalizeInteractiveChoice("")).toBe("");
    expect(normalizeInteractiveChoice("unknown")).toBe("");
  });

  test("scores direct alias matches", () => {
    const search = INTERACTIVE_ACTIONS.find((action) => action.key === "1");
    expect(search).toBeDefined();
    if (!search) return;

    const direct = scoreInteractiveAction(search, "search");
    const partial = scoreInteractiveAction(search, "sea");
    expect(direct).toBeGreaterThan(partial);
  });
});
