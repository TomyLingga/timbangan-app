// Points are kept for settings.gps_retention_days. A job inside the API process deletes older ones once a day; the
// last position of each vehicle is a separate row and is never deleted. Tests run the deletion by hand.
import type { Database } from "../db/client.js";
import { gpsSettings } from "./trips.js";

const DAY_MS = 86_400_000;
/** The first run waits a little, so it never slows the start. */
const FIRST_RUN_MS = 5 * 60_000;

/** Deletes points, and unknown device ids not heard from, older than the retention. Answers what was deleted. */
export async function pruneGpsPositions(database: Database, now: Date): Promise<{ positions: number; unknownDevices: number }> {
  const { retentionDays } = await gpsSettings(database.db);
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS).toISOString();
  const [positions] = await database.query<{ n: number }>(
    "with gone as (delete from vehicle_positions where at < $1::timestamptz returning 1) select count(*)::int as n from gone",
    [cutoff],
  );
  const [unknownDevices] = await database.query<{ n: number }>(
    "with gone as (delete from gps_unknown_devices where last_seen_at < $1::timestamptz returning 1) select count(*)::int as n from gone",
    [cutoff],
  );
  return { positions: Number(positions?.n ?? 0), unknownDevices: Number(unknownDevices?.n ?? 0) };
}

export interface RetentionLog {
  info: (data: object, message: string) => void;
  warn: (data: object, message: string) => void;
}

/** Runs the deletion a few minutes after the start and then once a day. Answers the function that stops it. */
export function scheduleGpsRetention(database: Database, now: () => Date, log: RetentionLog, everyMs = DAY_MS, firstMs = FIRST_RUN_MS): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const round = async () => {
    try {
      const deleted = await pruneGpsPositions(database, now());
      if (deleted.positions > 0 || deleted.unknownDevices > 0) log.info(deleted, "old GPS points deleted");
    } catch (error) {
      log.warn({ err: error }, "GPS retention failed");
    }
    if (!stopped) {
      timer = setTimeout(() => void round(), everyMs);
      timer.unref();
    }
  };
  timer = setTimeout(() => void round(), firstMs);
  timer.unref();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
