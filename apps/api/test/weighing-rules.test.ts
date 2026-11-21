// The tolerance formula of the old system and the contract tolerance of the gross check (pure functions).
import { describe, expect, it } from "vitest";
import { exceedsTolerance, grossTolerance, platesMatch } from "../src/weighing/rules.js";

describe("exceedsTolerance: |reference - weighed| / reference > percent / 100", () => {
  it("passes exactly at the limit and fails one kilogram past it", () => {
    // 0.1 % of 30 000 kg is 30 kg
    expect(exceedsTolerance(30_000, 30_030, { pct: 0.1, kg: null })).toBe(false);
    expect(exceedsTolerance(30_000, 29_970, { pct: 0.1, kg: null })).toBe(false);
    expect(exceedsTolerance(30_000, 30_031, { pct: 0.1, kg: null })).toBe(true);
    expect(exceedsTolerance(30_000, 29_969, { pct: 0.1, kg: null })).toBe(true);
    // 0.15 % of 15 000 kg is 22.5 kg
    expect(exceedsTolerance(15_000, 15_022, { pct: 0.15, kg: null })).toBe(false);
    expect(exceedsTolerance(15_000, 15_023, { pct: 0.15, kg: null })).toBe(true);
    // four decimals of a percent are exact
    expect(exceedsTolerance(1_000_000, 1_000_123, { pct: 0.0123, kg: null })).toBe(false);
    expect(exceedsTolerance(1_000_000, 1_000_124, { pct: 0.0123, kg: null })).toBe(true);
  });

  it("passes when either filled threshold is met, and checks nothing when none is filled", () => {
    expect(exceedsTolerance(15_000, 15_040, { pct: 0.15, kg: 50 })).toBe(false);
    expect(exceedsTolerance(15_000, 15_051, { pct: 0.15, kg: 50 })).toBe(true);
    expect(exceedsTolerance(15_000, 15_050, { pct: null, kg: 50 })).toBe(false);
    expect(exceedsTolerance(15_000, 15_051, { pct: null, kg: 50 })).toBe(true);
    expect(exceedsTolerance(15_000, 99_999, { pct: null, kg: null })).toBe(false);
  });
});

describe("grossTolerance", () => {
  it("takes the smallest contract tolerance above zero; all zero means no check; a rule percent wins", () => {
    expect(grossTolerance(null, [0, 0.5, 0.2])).toBe(0.2);
    expect(grossTolerance(null, [0.3])).toBe(0.3);
    expect(grossTolerance(null, [0, 0])).toBeNull();
    expect(grossTolerance(null, [])).toBeNull();
    expect(grossTolerance(0.25, [0, 0.5])).toBe(0.25);
  });
});

describe("platesMatch", () => {
  it("compares upper case without spaces; no camera text never matches", () => {
    expect(platesMatch(" bk 8001-aa ", "BK8001AA")).toBe(true);
    expect(platesMatch("BK8001AB", "BK8001AA")).toBe(false);
    expect(platesMatch(null, "BK8001AA")).toBe(false);
    expect(platesMatch("", "BK8001AA")).toBe(false);
  });
});
