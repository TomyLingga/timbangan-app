import { describe, expect, it } from "vitest";
import { computeDifference } from "../src/shared/difference";

const letters = { docGrossKg: 41_000, docTareKg: 10_000, docNetKg: 31_000 };
const none = { grossKg: null, tareKg: null, netKg: null };

describe("computeDifference", () => {
  it("shows only the letters before anything is weighed", () => {
    expect(computeDifference(letters, none, null)).toEqual({
      gross: { doc: 41_000, weighed: null, diffKg: null, diffPct: null },
      tare: { doc: 10_000, weighed: null, diffKg: null, diffPct: null },
      net: { doc: 31_000, weighed: null, diffKg: null, diffPct: null },
    });
  });

  it("takes the live weight as the figure of the stage being weighed and gives the difference in kg and percent", () => {
    const result = computeDifference(letters, none, { kind: "GROSS", weightKg: 41_500 });
    expect(result.gross).toEqual({ doc: 41_000, weighed: 41_500, diffKg: 500, diffPct: 1.22 });
    expect(result.net.weighed).toBeNull();
  });

  it("derives the net once gross and tare exist, from the trip and the live weight together", () => {
    const result = computeDifference(letters, { grossKg: 41_480, tareKg: null, netKg: null }, { kind: "TARE", weightKg: 10_460 });
    expect(result.tare).toEqual({ doc: 10_000, weighed: 10_460, diffKg: 460, diffPct: 4.6 });
    expect(result.net).toEqual({ doc: 31_000, weighed: 31_020, diffKg: 20, diffPct: 0.06 });
  });

  it("prefers the saved figures of the trip over the live weight", () => {
    const result = computeDifference(letters, { grossKg: 41_480, tareKg: 10_460, netKg: 31_020 }, { kind: "TARE", weightKg: 300 });
    expect(result.tare.weighed).toBe(10_460);
    expect(result.net.weighed).toBe(31_020);
  });

  it("gives no difference without a letter figure, and no percent against zero", () => {
    const result = computeDifference({ docGrossKg: null, docTareKg: 0, docNetKg: null }, { grossKg: 41_000, tareKg: 15, netKg: null }, null);
    expect(result.gross).toEqual({ doc: null, weighed: 41_000, diffKg: null, diffPct: null });
    expect(result.tare).toEqual({ doc: 0, weighed: 15, diffKg: 15, diffPct: null });
  });

  it("ignores an empty scale as a live figure", () => {
    expect(computeDifference(letters, none, { kind: "GROSS", weightKg: 0 }).gross.weighed).toBeNull();
  });
});
