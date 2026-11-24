// What happens to a batch of positions, whichever source sent it: each point is checked on its own (coordinates, time),
// then against the vehicle's other points (same time: duplicate; too fast from or to a neighbour: impossible jump),
// and what remains is stored with the vehicle's trip. The last position of the vehicle only moves forward.
import { z } from "zod";
import type { SqlRunner } from "../db/client.js";
import type { PositionSourceKind } from "../db/schema.js";
import { distanceKm } from "./geo.js";

/** More than this many minutes ahead of the server clock is refused. */
export const FUTURE_TOLERANCE_MS = 5 * 60_000;
/** Faster than this between two points of one vehicle is an impossible jump. */
export const MAX_SPEED_KPH = 200;
/** Two fixes closer than this are never a jump: GPS wanders a little even when the truck stands still. */
export const JITTER_KM = 0.5;
const DAY_MS = 86_400_000;

const optionalNumber = (message: string) => z.number(message).nullable().optional();

/** The fields of one point, as both intake routes take them. */
export const pointFields = {
  at: z.iso.datetime({ offset: true, message: "Waktu harus berformat ISO 8601 dengan zona waktu, misalnya 2026-11-20T03:00:00Z." }),
  lat: z.number("Lintang harus angka."),
  lon: z.number("Bujur harus angka."),
  speedKph: optionalNumber("Kecepatan harus angka."),
  headingDeg: optionalNumber("Arah harus angka."),
  accuracyM: optionalNumber("Ketelitian harus angka."),
};
export type PointInput = z.infer<z.ZodObject<typeof pointFields>>;

export interface RefusedBy {
  range: number;
  future: number;
  tooOld: number;
  jump: number;
}
export const noRefusal = (): RefusedBy => ({ range: 0, future: 0, tooOld: 0, jump: 0 });

/** A point that passed the checks of its own. */
export interface Candidate {
  at: Date;
  lat: number;
  lon: number;
  speedKph: number | null;
  headingDeg: number | null;
  accuracyM: number | null;
}

const inRange = (value: number | null | undefined, min: number, max: number) => value === null || value === undefined || (value >= min && value <= max);

/** Why a point is refused on its own, or null. (0, 0) is what many trackers send without a fix. */
function ownFault(point: PointInput, at: Date, now: Date, retentionDays: number): keyof RefusedBy | null {
  if (!inRange(point.lat, -90, 90) || !inRange(point.lon, -180, 180) || (point.lat === 0 && point.lon === 0)) return "range";
  if (!inRange(point.speedKph, 0, 400) || !inRange(point.headingDeg, 0, 360) || !inRange(point.accuracyM, 0, 100_000)) return "range";
  if (at.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) return "future";
  if (at.getTime() < now.getTime() - retentionDays * DAY_MS) return "tooOld";
  return null;
}

/** Splits the points into candidates and the counts of the refused ones. */
export function screen(points: PointInput[], now: Date, retentionDays: number, refusedBy: RefusedBy): Candidate[] {
  const kept: Candidate[] = [];
  for (const point of points) {
    const at = new Date(point.at);
    const fault = ownFault(point, at, now, retentionDays);
    if (fault) {
      refusedBy[fault]++;
      continue;
    }
    kept.push({ at, lat: point.lat, lon: point.lon, speedKph: point.speedKph ?? null, headingDeg: point.headingDeg ?? null, accuracyM: point.accuracyM ?? null });
  }
  return kept;
}

interface Fix {
  t: number;
  lat: number;
  lon: number;
}

function isJump(a: Fix | undefined, b: Fix | undefined): boolean {
  if (!a || !b) return false;
  const km = distanceKm(a, b);
  if (km <= JITTER_KM) return false;
  const hours = Math.abs(b.t - a.t) / 3_600_000;
  return km / hours > MAX_SPEED_KPH;
}

export interface StoreTarget {
  vehicleId: number;
  tripId: number | null;
  sourceKind: PositionSourceKind;
  sourceId: number | null;
}

/** Stores the candidates of one vehicle. Answers what was stored and what was a duplicate or a jump. */
export async function storeForVehicle(db: SqlRunner, target: StoreTarget, candidates: Candidate[], now: Date): Promise<{ stored: number; duplicates: number; jumps: number }> {
  if (candidates.length === 0) return { stored: 0, duplicates: 0, jumps: 0 };
  const sorted = [...candidates].sort((a, b) => a.at.getTime() - b.at.getTime());
  const first = (sorted[0] as Candidate).at.toISOString();
  const last = (sorted[sorted.length - 1] as Candidate).at.toISOString();
  // the stored neighbours of the batch: the point before, the points inside its span, the point after
  const rows = await db.query<{ at: Date; lat: number; lon: number }>(
    `(select at, lat, lon from vehicle_positions where vehicle_id = $1::bigint and at < $2::timestamptz order by at desc limit 1)
     union all
     (select at, lat, lon from vehicle_positions where vehicle_id = $1::bigint and at >= $2::timestamptz and at <= $3::timestamptz)
     union all
     (select at, lat, lon from vehicle_positions where vehicle_id = $1::bigint and at > $3::timestamptz order by at asc limit 1)`,
    [target.vehicleId, first, last],
  );
  const known: Fix[] = rows.map((row) => ({ t: new Date(row.at).getTime(), lat: Number(row.lat), lon: Number(row.lon) })).sort((a, b) => a.t - b.t);
  let duplicates = 0;
  let jumps = 0;
  const accepted: Candidate[] = [];
  for (const candidate of sorted) {
    const fix = { t: candidate.at.getTime(), lat: candidate.lat, lon: candidate.lon };
    let index = known.findIndex((other) => other.t >= fix.t);
    if (index === -1) index = known.length;
    if (known[index]?.t === fix.t) {
      duplicates++;
      continue;
    }
    if (isJump(known[index - 1], fix) || isJump(fix, known[index])) {
      jumps++;
      continue;
    }
    known.splice(index, 0, fix);
    accepted.push(candidate);
  }
  if (accepted.length === 0) return { stored: 0, duplicates, jumps };

  const payload = JSON.stringify(
    accepted.map((point) => ({ at: point.at.toISOString(), lat: point.lat, lon: point.lon, speed: point.speedKph, heading: point.headingDeg, accuracy: point.accuracyM })),
  );
  const inserted = await db.query<{ at: Date }>(
    `insert into vehicle_positions (vehicle_id, trip_id, at, lat, lon, speed_kph, heading_deg, accuracy_m, source_kind, source_id, received_at)
     select $1::bigint, $2::bigint, x.at, x.lat, x.lon, x.speed, x.heading, x.accuracy, $3::text, $4::bigint, $5::timestamptz
     from jsonb_to_recordset($6::jsonb) as x (at timestamptz, lat float8, lon float8, speed real, heading real, accuracy real)
     on conflict (vehicle_id, at) do nothing
     returning at`,
    [target.vehicleId, target.tripId, target.sourceKind, target.sourceId, now.toISOString(), payload],
  );
  // a point stored by a request running at the same time counts as a duplicate
  duplicates += accepted.length - inserted.length;
  if (inserted.length > 0) {
    const newest = Math.max(...inserted.map((row) => new Date(row.at).getTime()));
    const point = accepted.find((candidate) => candidate.at.getTime() === newest) as Candidate;
    await db.query(
      `insert into vehicle_last_positions (vehicle_id, trip_id, at, lat, lon, speed_kph, heading_deg, accuracy_m, source_kind, received_at)
       values ($1::bigint, $2::bigint, $3::timestamptz, $4::float8, $5::float8, $6::real, $7::real, $8::real, $9::text, $10::timestamptz)
       on conflict (vehicle_id) do update set
         trip_id = excluded.trip_id, at = excluded.at, lat = excluded.lat, lon = excluded.lon, speed_kph = excluded.speed_kph,
         heading_deg = excluded.heading_deg, accuracy_m = excluded.accuracy_m, source_kind = excluded.source_kind, received_at = excluded.received_at
       where vehicle_last_positions.at < excluded.at`,
      [target.vehicleId, target.tripId, point.at.toISOString(), point.lat, point.lon, point.speedKph, point.headingDeg, point.accuracyM, target.sourceKind, now.toISOString()],
    );
  }
  return { stored: inserted.length, duplicates, jumps };
}

/** The answer of an intake route. */
export interface IntakeAnswer {
  stored: number;
  duplicates: number;
  refused: number;
  refusedBy: RefusedBy;
}

export const total = (refusedBy: RefusedBy) => refusedBy.range + refusedBy.future + refusedBy.tooOld + refusedBy.jump;
