import { describe, expect, it } from "vitest";
import { initialTruckLeft, watchTruckLeft } from "../src/shared/truck-left";

function run(readings: [number, number | null][]) {
  let state = initialTruckLeft();
  let last = { left: false, secondsLeft: null as number | null };
  for (const [now, weight] of readings) {
    const step = watchTruckLeft(state, weight, now);
    state = step.state;
    last = { left: step.left, secondsLeft: step.secondsLeft };
  }
  return last;
}

describe("watchTruckLeft", () => {
  it("does nothing while the weight is 1000 kg or more", () => {
    expect(run([[0, 41_000], [10_000, 1_000]])).toEqual({ left: false, secondsLeft: null });
  });

  it("reports the truck gone after 5 seconds below 1000 kg, with the seconds left before that", () => {
    expect(run([[0, 999], [1_000, 400]])).toEqual({ left: false, secondsLeft: 4 });
    expect(run([[0, 999], [4_999, 0]])).toEqual({ left: false, secondsLeft: 1 });
    expect(run([[0, 999], [5_000, 0]])).toEqual({ left: true, secondsLeft: 0 });
  });

  it("starts the 5 seconds again when the weight comes back", () => {
    expect(run([[0, 500], [4_000, 500], [4_500, 30_000], [5_000, 500], [9_000, 500]])).toEqual({ left: false, secondsLeft: 1 });
  });

  it("does not count time without a reading", () => {
    expect(run([[0, 500], [3_000, null], [6_000, 500]])).toEqual({ left: false, secondsLeft: 5 });
  });
});
