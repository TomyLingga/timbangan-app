// When a trip counts as "on the road" for GPS, the settings that decide it, and a small builder for $n parameters of
// the raw SQL the GPS routes run.
import type { Orm, SqlRunner } from "../db/client.js";
import { defaultSite, readSetting } from "../settings.js";

/** Collects the parameters of one statement; `add` answers the placeholder, with a cast when given. */
export class SqlParams {
  readonly values: unknown[] = [];

  add(value: unknown, cast?: string): string {
    this.values.push(value instanceof Date ? value.toISOString() : value);
    return `$${this.values.length}${cast ? `::${cast}` : ""}`;
  }
}

export interface GpsSettings {
  /** Points older than this many days are refused and deleted. */
  retentionDays: number;
  /** How long after leaving the plant an outgoing trip stays on the road for its customer and the driver's link. */
  customerDays: number;
  /** Where the plant is; null until an admin sets it. */
  plant: { lat: number; lon: number } | null;
}

const positive = (value: unknown, fallback: number) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

/** The GPS settings of the default site (one site today). */
export async function gpsSettings(orm: Orm): Promise<GpsSettings> {
  const site = await defaultSite(orm);
  const plant = await readSetting<{ lat?: unknown; lon?: unknown } | null>(orm, site.id, "plant_location");
  const lat = Number(plant?.lat);
  const lon = Number(plant?.lon);
  return {
    retentionDays: positive(await readSetting(orm, site.id, "gps_retention_days"), 90),
    customerDays: positive(await readSetting(orm, site.id, "gps_customer_days_after_exit"), 3),
    plant: plant && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null,
  };
}

/**
 * SQL: trip `t` (with its registration `r`) is on the road. From the SPJ until the trip is closed: issued with an SPJ
 * still valid, checked in, or in process; an outgoing trip also while it left the plant less than `customerDays` ago.
 */
export function onTheRoad(params: SqlParams, now: Date, customerDays: number, t = "t", r = "r"): string {
  const at = params.add(now, "timestamptz");
  const days = params.add(customerDays, "int");
  return `(${t}.status in ('CHECKED_IN', 'IN_PROCESS')
    or (${t}.status = 'ISSUED' and exists (select 1 from spj_documents s where s.trip_id = ${t}.id and s.revoked_at is null and (s.valid_until is null or s.valid_until > ${at})))
    or (${r}.direction = 'OUT' and ${t}.status = 'COMPLETED' and ${t}.exited_at > ${at} - make_interval(days => ${days})))`;
}

/** Ordering of several trips on the road of one vehicle: inside the plant first, then issued, then the latest exit. */
export const ROAD_ORDER = (t = "t") =>
  `case when ${t}.status in ('CHECKED_IN', 'IN_PROCESS') then 0 when ${t}.status = 'ISSUED' then 1 else 2 end, ${t}.exited_at desc nulls last, ${t}.id desc`;

/** The trip the vehicle is on now, or null. */
export async function roadTripOf(db: SqlRunner, vehicleId: number, now: Date, customerDays: number): Promise<number | null> {
  const params = new SqlParams();
  const vehicle = params.add(vehicleId, "bigint");
  const road = onTheRoad(params, now, customerDays);
  const [row] = await db.query<{ id: number }>(
    `select t.id::float8 as id from trips t join registrations r on r.id = t.registration_id
     where t.vehicle_id = ${vehicle} and ${road} order by ${ROAD_ORDER()} limit 1`,
    params.values,
  );
  return row ? Number(row.id) : null;
}
