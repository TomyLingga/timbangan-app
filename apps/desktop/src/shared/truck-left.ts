// While a truck waits for a decision: below 1000 kg for 5 seconds means it has left the scale. A missing reading
// is not taken as evidence either way and starts the count again. Pure.

export const TRUCK_LEFT = { belowKg: 1_000, forMs: 5_000 } as const;

export interface TruckLeftState {
  lowSince: number | null;
}

export const initialTruckLeft = (): TruckLeftState => ({ lowSince: null });

export function watchTruckLeft(state: TruckLeftState, weightKg: number | null, now: number): { state: TruckLeftState; left: boolean; secondsLeft: number | null } {
  if (weightKg === null || weightKg >= TRUCK_LEFT.belowKg) return { state: { lowSince: null }, left: false, secondsLeft: null };
  const lowSince = state.lowSince ?? now;
  const elapsed = now - lowSince;
  const left = elapsed >= TRUCK_LEFT.forMs;
  return { state: { lowSince }, left, secondsLeft: left ? 0 : Math.ceil((TRUCK_LEFT.forMs - elapsed) / 1_000) };
}
