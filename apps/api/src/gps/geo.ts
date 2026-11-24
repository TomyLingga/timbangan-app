// Distances on the earth's surface, and the in-memory request window shared by the GPS intake routes.

const EARTH_RADIUS_KM = 6371.0088;
const rad = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle distance in kilometres (haversine). */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Counts requests per key in memory: at most `limit` inside a sliding window. A restart clears the counters, as with
 * the login throttle.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly now: () => Date,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records one request of the key; false when the key already used up its window. */
  take(key: string): boolean {
    const now = this.now().getTime();
    const kept = (this.hits.get(key) ?? []).filter((at) => at > now - this.windowMs);
    if (kept.length >= this.limit) {
      this.hits.set(key, kept);
      return false;
    }
    kept.push(now);
    this.hits.set(key, kept);
    // forget keys whose window passed, so the map does not grow with every token ever seen
    if (this.hits.size > 1000) {
      for (const [other, times] of this.hits) if (times.every((at) => at <= now - this.windowMs)) this.hits.delete(other);
    }
    return true;
  }
}
