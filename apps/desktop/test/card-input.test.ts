import { describe, expect, it } from "vitest";
import { feedCardKey, initialCardInput, normaliseCardUid } from "../src/shared/card-input";

/** Types the keys with the given gap in milliseconds and returns the cards read. */
function type(keys: string[], gapMs: number, startAt = 0) {
  let state = initialCardInput();
  const cards: string[] = [];
  keys.forEach((key, index) => {
    const step = feedCardKey(state, key, startAt + index * gapMs);
    state = step.state;
    if (step.card) cards.push(step.card);
  });
  return cards;
}

const keys = (text: string) => [...text, "Enter"];

describe("feedCardKey", () => {
  it("reads fast keystrokes ending in Enter as a card", () => {
    expect(type(keys("04a1b2c3d4"), 8)).toEqual(["04A1B2C3D4"]);
  });

  it("does not read slow typing as a card", () => {
    expect(type(keys("04A1B2C3D4"), 150)).toEqual([]);
  });

  it("starts again after a pause, so a stray key before the reader does not spoil the card", () => {
    let state = initialCardInput();
    state = feedCardKey(state, "x", 0).state;
    let card: string | null = null;
    keys("0011223344").forEach((key, index) => {
      const step = feedCardKey(state, key, 1_000 + index * 10);
      state = step.state;
      card = step.card ?? card;
    });
    expect(card).toBe("0011223344");
  });

  it("refuses too short input and an Enter that comes late", () => {
    expect(type(keys("1234"), 10)).toEqual([]);
    let state = initialCardInput();
    "0011223344".split("").forEach((key, index) => (state = feedCardKey(state, key, index * 10).state));
    expect(feedCardKey(state, "Enter", 2_000).card).toBeNull();
  });

  it("ignores modifier and other named keys without breaking the card", () => {
    expect(type(["Shift", ..."0A0B0C0D", "Shift", "Enter"], 5)).toEqual(["0A0B0C0D"]);
  });

  it("refuses text that is not a hexadecimal UID", () => {
    expect(type(keys("HELLOWORLD"), 5)).toEqual([]);
  });
});

describe("normaliseCardUid", () => {
  it("upper-cases and removes spaces, colons, dots and dashes", () => {
    expect(normaliseCardUid(" 04:a1-b2.c3 d4 ")).toBe("04A1B2C3D4");
  });

  it("refuses anything outside 8 to 20 hexadecimal characters", () => {
    expect(normaliseCardUid("ABC")).toBeNull();
    expect(normaliseCardUid("0".repeat(21))).toBeNull();
    expect(normaliseCardUid("04A1B2C3DZ")).toBeNull();
  });
});
