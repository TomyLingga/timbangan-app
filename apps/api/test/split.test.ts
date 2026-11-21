// Splitting the net weight of a truck over its contracts or DOs (pure functions).
import { describe, expect, it } from "vitest";
import { splitEqually, splitNet, splitProportional, splitSequential } from "../src/weighing/split.js";

describe("net split", () => {
  it("gives one allocation everything (SINGLE)", () => {
    expect(splitNet("IN", 25_000, [{ seq: 1, originNetKg: 10, remaining: null }])).toEqual({ method: "SINGLE", shares: [25_000] });
    expect(splitNet("OUT", 25_000, [{ seq: 1, originNetKg: null, remaining: 3 }])).toEqual({ method: "SINGLE", shares: [25_000] });
  });

  it("splits incoming by the origin net of each contract, rounded to the kilogram, the remainder to the last (PROPORTIONAL)", () => {
    // 30 001 kg over 20 000 : 11 000 = 19 355.48 and 10 645.52
    expect(splitProportional(30_001, [20_000, 11_000])).toEqual([19_355, 10_646]);
    // three equal letters: 10 000 / 3 rounds to 3 333 twice, the last takes 3 334
    expect(splitProportional(10_000, [5, 5, 5])).toEqual([3_333, 3_333, 3_334]);
    expect(splitNet("IN", 30_001, [{ seq: 1, originNetKg: 20_000, remaining: null }, { seq: 2, originNetKg: 11_000, remaining: null }])).toEqual({
      method: "PROPORTIONAL",
      shares: [19_355, 10_646],
    });
  });

  it("splits incoming equally when an origin net is missing", () => {
    expect(splitNet("IN", 10_001, [{ seq: 1, originNetKg: 20_000, remaining: null }, { seq: 2, originNetKg: null, remaining: null }])).toEqual({
      method: "PROPORTIONAL",
      shares: [5_000, 5_001],
    });
    expect(splitEqually(7, 3)).toEqual([2, 2, 3]);
  });

  it("fills outgoing DOs from the smallest remainder, the last DO taking all that is left (SEQUENTIAL)", () => {
    // remainders 30 000, 8 000, 12 000: the 8 000 DO first, then 12 000, the 30 000 one gets the rest
    expect(splitSequential(25_000, [30_000, 8_000, 12_000])).toEqual([5_000, 8_000, 12_000]);
    // less net than the smallest remainder: everything to the first in line
    expect(splitSequential(5_000, [30_000, 8_000])).toEqual([0, 5_000]);
    // more net than all remainders: the last in line takes the excess
    expect(splitSequential(50_000, [10_000, 20_000])).toEqual([10_000, 40_000]);
    // a DO already overfilled counts as nothing left
    expect(splitSequential(9_000, [-500, 4_000])).toEqual([0, 9_000]);
    expect(splitNet("OUT", 25_000, [{ seq: 1, originNetKg: null, remaining: 30_000 }, { seq: 2, originNetKg: null, remaining: 8_000 }]).method).toBe("SEQUENTIAL");
  });

  it("always adds up to the truck's net", () => {
    for (const net of [0, 1, 999, 30_001, 41_237]) {
      for (const weights of [[1], [1, 1], [3, 7, 11], [20_000, 11_000, 1]]) {
        expect(splitProportional(net, weights).reduce((a, b) => a + b, 0)).toBe(net);
        expect(splitSequential(net, weights).reduce((a, b) => a + b, 0)).toBe(net);
      }
    }
  });
});
