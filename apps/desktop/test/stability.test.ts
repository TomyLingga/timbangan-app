import { describe, expect, it } from "vitest";
import { initialStability, sampleStability, type StabilityState, type StabilityStatus } from "../src/shared/stability";

/** Feeds one weight per call at the given times and returns the last status. */
function run(readings: [number, number | null][], start: StabilityState = initialStability()) {
  let state = start;
  let status: StabilityStatus = { kind: "empty" };
  let unstable = 0;
  for (const [now, weight] of readings) {
    const step = sampleStability(state, weight, now);
    state = step.state;
    status = step.status;
    if (step.unstable) unstable++;
  }
  return { state, status, unstable };
}

describe("sampleStability", () => {
  it("is empty without a weight or at zero", () => {
    expect(run([[0, null]]).status).toEqual({ kind: "empty" });
    expect(run([[0, 0]]).status).toEqual({ kind: "empty" });
  });

  it("starts a 3 second countdown after the same weight on three readings 500 ms apart", () => {
    expect(run([[0, 41_500], [500, 41_500]]).status).toEqual({ kind: "settling", weightKg: 41_500, readings: 2 });
    expect(run([[0, 41_500], [500, 41_500], [1_000, 41_500]]).status).toEqual({ kind: "countdown", weightKg: 41_500, secondsLeft: 3 });
  });

  it("samples only every 500 ms: calls in between do not count as readings", () => {
    expect(run([[0, 41_500], [100, 41_500], [200, 41_500], [300, 41_500]]).status).toEqual({ kind: "settling", weightKg: 41_500, readings: 1 });
  });

  it("counts the countdown down and reports stable when it ends with the same weight", () => {
    const base: [number, number][] = [[0, 41_500], [500, 41_500], [1_000, 41_500]];
    expect(run([...base, [1_500, 41_500], [2_000, 41_500]]).status).toEqual({ kind: "countdown", weightKg: 41_500, secondsLeft: 2 });
    expect(run([...base, [1_500, 41_500], [2_000, 41_500], [2_500, 41_500], [3_000, 41_500]]).status).toEqual({ kind: "countdown", weightKg: 41_500, secondsLeft: 1 });
    expect(run([...base, [1_500, 41_500], [2_000, 41_500], [2_500, 41_500], [3_000, 41_500], [3_500, 41_500], [4_000, 41_500]]).status).toEqual({ kind: "stable", weightKg: 41_500 });
  });

  it("restarts from the first reading when the weight changes, also during the countdown", () => {
    const changed = run([[0, 41_500], [500, 41_500], [1_000, 41_500], [1_500, 41_520]]);
    expect(changed.status).toEqual({ kind: "settling", weightKg: 41_520, readings: 1 });
    expect(run([[2_000, 41_520], [2_500, 41_520]], changed.state).status).toEqual({ kind: "countdown", weightKg: 41_520, secondsLeft: 3 });
  });

  it("starts over when the weight drops to zero", () => {
    const off = run([[0, 41_500], [500, 41_500], [1_000, 41_500], [1_500, 0]]);
    expect(off.status).toEqual({ kind: "empty" });
    expect(run([[2_000, 41_500]], off.state).status).toEqual({ kind: "settling", weightKg: 41_500, readings: 1 });
  });

  it("raises one unstable notice after ten changes and counts again from zero", () => {
    const readings: [number, number][] = [];
    for (let i = 0; i <= 20; i++) readings.push([i * 500, 40_000 + i * 10]);
    // the first reading is not a change; changes 10 and 20 raise the notice
    expect(run(readings).unstable).toBe(2);
    expect(run(readings.slice(0, 10)).unstable).toBe(0);
    expect(run(readings.slice(0, 11)).unstable).toBe(1);
  });
});
