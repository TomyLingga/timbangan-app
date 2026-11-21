// When a weight may be sent: the same weight on three readings taken 500 ms apart, then a 3 second countdown.
// Any change restarts from the first reading. Ten changes without reaching stable raise an "unstable" notice, as
// the old program did. Pure: the caller passes the latest weight and the time on every call; a reading is taken
// only when 500 ms have passed since the last one.

export const STABILITY = {
  sampleMs: 500,
  readingsNeeded: 3,
  countdownMs: 3_000,
  unstableAfterChanges: 10,
} as const;

export interface StabilityState {
  /** The weight of the current run of equal readings; null when the scale is empty. */
  weightKg: number | null;
  readings: number;
  nextSampleAt: number | null;
  countdownEndsAt: number | null;
  /** Weight changes since the last notice. */
  changes: number;
}

export type StabilityStatus =
  | { kind: "empty" }
  | { kind: "settling"; weightKg: number; readings: number }
  | { kind: "countdown"; weightKg: number; secondsLeft: number }
  | { kind: "stable"; weightKg: number };

export const initialStability = (): StabilityState => ({ weightKg: null, readings: 0, nextSampleAt: null, countdownEndsAt: null, changes: 0 });

function statusOf(state: StabilityState, now: number): StabilityStatus {
  if (state.weightKg === null) return { kind: "empty" };
  if (state.countdownEndsAt === null) return { kind: "settling", weightKg: state.weightKg, readings: state.readings };
  if (now >= state.countdownEndsAt) return { kind: "stable", weightKg: state.weightKg };
  return { kind: "countdown", weightKg: state.weightKg, secondsLeft: Math.ceil((state.countdownEndsAt - now) / 1_000) };
}

export function sampleStability(state: StabilityState, weightKg: number | null, now: number): { state: StabilityState; status: StabilityStatus; unstable: boolean } {
  if (state.nextSampleAt !== null && now < state.nextSampleAt) return { state, status: statusOf(state, now), unstable: false };
  const nextSampleAt = now + STABILITY.sampleMs;

  if (weightKg === null || weightKg <= 0) {
    const next: StabilityState = { ...initialStability(), nextSampleAt, changes: state.changes };
    return { state: next, status: { kind: "empty" }, unstable: false };
  }

  if (weightKg === state.weightKg) {
    const readings = state.readings + 1;
    const countdownEndsAt = state.countdownEndsAt ?? (readings >= STABILITY.readingsNeeded ? now + STABILITY.countdownMs : null);
    const next: StabilityState = { ...state, readings, nextSampleAt, countdownEndsAt };
    return { state: next, status: statusOf(next, now), unstable: false };
  }

  // a new weight: the first reading of a new run; it counts as a change when there was a weight before
  let changes = state.weightKg === null ? state.changes : state.changes + 1;
  let unstable = false;
  if (changes >= STABILITY.unstableAfterChanges) {
    unstable = true;
    changes = 0;
  }
  const next: StabilityState = { weightKg, readings: 1, nextSampleAt, countdownEndsAt: null, changes };
  return { state: next, status: statusOf(next, now), unstable };
}
