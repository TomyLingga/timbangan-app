// The size a photo is shrunk to before upload: the long side at most 1,600 px (docs/fase-5-rancangan.md, section 3).

export const MAX_PHOTO_SIDE = 1600;
export const JPEG_QUALITY = 0.8;

/** The resize to apply, or null when the photo is small enough already. Only one side is given; the other follows. */
export function resizeTarget(width: number, height: number, max = MAX_PHOTO_SIDE): { width: number } | { height: number } | null {
  if (width <= 0 || height <= 0) return null;
  if (Math.max(width, height) <= max) return null;
  return width >= height ? { width: max } : { height: max };
}
