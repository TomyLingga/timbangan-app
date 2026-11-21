// Shared motion values: short, decelerating, the same everywhere. The verb of
// the app is "settle like a readout": things arrive from a few pixels away and
// stop cleanly, never bounce.
export const MOTION_EASE = [0.2, 0, 0, 1] as const;

/** Buttons, tab indicator. */
export const MOTION_FAST = 0.15;

/** Page and list entrances. */
export const MOTION_BASE = 0.2;

/** Larger surfaces: state panels at the post, the sign-in scene entrance. */
export const MOTION_SLOW = 0.3;

/** The sidebar marker and other shared-layout moves. */
export const MOTION_SPRING = { type: "spring", stiffness: 520, damping: 42, mass: 0.9 } as const;

/** Delay between list rows, capped so long lists do not crawl in. */
export function rowDelay(index: number): number {
  return Math.min(index, 10) * 0.02;
}
