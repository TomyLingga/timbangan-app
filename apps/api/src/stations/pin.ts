// The station PIN: opens manual plate entry on the weighbridge program. Stored as an argon2 hash. Five wrong
// attempts in a row lock it for five minutes; a right PIN resets the count.
import { eq } from "drizzle-orm";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import type { Orm } from "../db/client.js";
import { stations } from "../db/schema.js";

export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MS = 5 * 60_000;
export const PIN_PATTERN = /^[0-9]{4,8}$/;

export type PinCheck =
  | { ok: true }
  | { ok: false; code: "PIN_NOT_SET" }
  | { ok: false; code: "PIN_WRONG"; attemptsLeft: number }
  | { ok: false; code: "PIN_LOCKED"; until: Date };

export async function setStationPin(orm: Orm, stationId: number, pin: string | null): Promise<void> {
  await orm
    .update(stations)
    .set({ pinHash: pin === null ? null : await hashPassword(pin), pinFailedCount: 0, pinLockedUntil: null })
    .where(eq(stations.id, stationId));
}

export async function checkStationPin(orm: Orm, stationId: number, pin: string, now: Date): Promise<PinCheck> {
  const [station] = await orm
    .select({ pinHash: stations.pinHash, failed: stations.pinFailedCount, lockedUntil: stations.pinLockedUntil })
    .from(stations)
    .where(eq(stations.id, stationId));
  if (!station?.pinHash) return { ok: false, code: "PIN_NOT_SET" };
  if (station.lockedUntil && station.lockedUntil > now) return { ok: false, code: "PIN_LOCKED", until: station.lockedUntil };
  if (await verifyPassword(station.pinHash, pin)) {
    await orm.update(stations).set({ pinFailedCount: 0, pinLockedUntil: null }).where(eq(stations.id, stationId));
    return { ok: true };
  }
  // a lock that has run out starts a new count
  const failed = (station.lockedUntil ? 0 : station.failed) + 1;
  if (failed >= PIN_MAX_FAILURES) {
    const until = new Date(now.getTime() + PIN_LOCK_MS);
    await orm.update(stations).set({ pinFailedCount: 0, pinLockedUntil: until }).where(eq(stations.id, stationId));
    return { ok: false, code: "PIN_LOCKED", until };
  }
  await orm.update(stations).set({ pinFailedCount: failed, pinLockedUntil: null }).where(eq(stations.id, stationId));
  return { ok: false, code: "PIN_WRONG", attemptsLeft: PIN_MAX_FAILURES - failed };
}
