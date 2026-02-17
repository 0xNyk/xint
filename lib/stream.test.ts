import { describe, expect, test } from "bun:test";
import { parseBackfillMinutes, parsePositiveInt } from "./stream";

describe("stream arg parsing", () => {
  test("parsePositiveInt accepts positive numbers", () => {
    expect(parsePositiveInt("7")).toBe(7);
  });

  test("parsePositiveInt rejects zero/negative/invalid", () => {
    expect(parsePositiveInt("0")).toBeNull();
    expect(parsePositiveInt("-2")).toBeNull();
    expect(parsePositiveInt("abc")).toBeNull();
    expect(parsePositiveInt(undefined)).toBeNull();
  });

  test("parseBackfillMinutes accepts only 1-5", () => {
    expect(parseBackfillMinutes("1")).toBe(1);
    expect(parseBackfillMinutes("5")).toBe(5);
    expect(parseBackfillMinutes("6")).toBeNull();
    expect(parseBackfillMinutes("0")).toBeNull();
  });
});
