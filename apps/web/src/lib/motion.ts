// Shared motion values: short, decelerating, the same everywhere.
export const MOTION_EASE = [0.2, 0, 0, 1] as const;

/** Buttons, tab indicator. */
export const MOTION_FAST = 0.15;

/** Page and list entrances. */
export const MOTION_BASE = 0.2;

/** Delay between list rows, capped so long lists do not crawl in. */
export function rowDelay(index: number): number {
  return Math.min(index, 10) * 0.02;
}
