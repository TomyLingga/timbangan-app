// POST /api/gps/positions: points from tracker devices, sent by a provider's server or by a device itself. The
// X-Tracker-Key header names a GPS source; there is no user account behind these requests.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { AppError } from "../errors.js";
import { keyMatches } from "../stations/keys.js";
import { RateLimiter } from "./geo.js";
import { type Candidate, noRefusal, pointFields, screen, storeForVehicle, total } from "./ingest.js";
import { sourceIdOfKey } from "./keys.js";
import { gpsSettings, roadTripOf } from "./trips.js";

/** Requests one key may send in a minute. */
export const DEVICE_REQUESTS_PER_MINUTE = 60;
export const MAX_DEVICE_POINTS = 500;
/** 500 points of about 150 bytes each, with room to spare. */
export const DEVICE_BODY_LIMIT = 256 * 1024;

const devicePoint = z.object({
  deviceId: z.string("Nomor alat wajib diisi.").trim().min(1, "Nomor alat wajib diisi.").max(64, "Nomor alat terlalu panjang."),
  ...pointFields,
});
const deviceBody = z.object({
  points: z
    .array(devicePoint, "points harus berupa daftar titik.")
    .min(1, "Kirim minimal satu titik.")
    .max(MAX_DEVICE_POINTS, `Paling banyak ${MAX_DEVICE_POINTS} titik per kiriman.`),
});

const unauthenticated = () => new AppError(401, "TRACKER_UNAUTHENTICATED", "Kunci kiriman tidak valid.");
export const rateLimited = () => new AppError(429, "RATE_LIMITED", "Terlalu banyak kiriman. Coba lagi sebentar lagi.");

export function registerGpsIntakeRoutes(app: FastifyInstance, context: AppContext): void {
  const database = context.database;
  const limiter = new RateLimiter(context.now, DEVICE_REQUESTS_PER_MINUTE, 60_000);

  /** The active source the key belongs to. The hash is compared even for a source that will be refused. */
  async function sourceOf(request: FastifyRequest): Promise<{ id: number }> {
    const header = request.headers["x-tracker-key"];
    const key = typeof header === "string" ? header.trim() : "";
    const sourceId = sourceIdOfKey(key);
    if (sourceId === null) throw unauthenticated();
    const [source] = await database.query<{ id: number; key_hash: string | null; is_active: boolean }>(
      "select id::float8 as id, key_hash, is_active from gps_sources where id = $1::bigint",
      [sourceId],
    );
    const matches = keyMatches(source?.key_hash ?? null, key);
    if (!source || !matches || !source.is_active) throw unauthenticated();
    return { id: Number(source.id) };
  }

  app.post("/api/gps/positions", { bodyLimit: DEVICE_BODY_LIMIT }, async (request) => {
    const source = await sourceOf(request);
    if (!limiter.take(String(source.id))) throw rateLimited();
    const body = deviceBody.parse(request.body);
    const now = context.now();
    await database.query("update gps_sources set last_seen_at = $1::timestamptz where id = $2::bigint", [now.toISOString(), source.id]);
    const settings = await gpsSettings(database.db);

    const byDevice = new Map<string, typeof body.points>();
    for (const point of body.points) byDevice.set(point.deviceId, [...(byDevice.get(point.deviceId) ?? []), point]);
    const trackers = await database.query<{ device_id: string; vehicle_id: number }>(
      `select device_id, vehicle_id::float8 as vehicle_id from vehicle_trackers
       where source_id = $1::bigint and is_active and device_id in (select jsonb_array_elements_text($2::jsonb))`,
      [source.id, JSON.stringify([...byDevice.keys()])],
    );
    const vehicleOf = new Map(trackers.map((row) => [row.device_id, Number(row.vehicle_id)]));

    // device ids no tracker knows: counted and remembered for the admin
    const unknownIds = [...byDevice.keys()].filter((id) => !vehicleOf.has(id)).sort();
    let unknown = 0;
    if (unknownIds.length > 0) {
      const seen = unknownIds.map((deviceId) => {
        const points = byDevice.get(deviceId) ?? [];
        unknown += points.length;
        const lastPointAt = new Date(Math.max(...points.map((point) => Date.parse(point.at)))).toISOString();
        return { device_id: deviceId, last_point_at: lastPointAt, n: points.length };
      });
      await database.query(
        `insert into gps_unknown_devices (source_id, device_id, first_seen_at, last_seen_at, last_point_at, point_count)
         select $1::bigint, x.device_id, $2::timestamptz, $2::timestamptz, x.last_point_at, x.n
         from jsonb_to_recordset($3::jsonb) as x (device_id text, last_point_at timestamptz, n int)
         on conflict (source_id, device_id) do update set
           last_seen_at = excluded.last_seen_at,
           last_point_at = greatest(gps_unknown_devices.last_point_at, excluded.last_point_at),
           point_count = gps_unknown_devices.point_count + excluded.point_count`,
        [source.id, now.toISOString(), JSON.stringify(seen)],
      );
    }

    // the points of one vehicle together: one device per vehicle, but keep it safe if that ever changes
    const refusedBy = noRefusal();
    const byVehicle = new Map<number, Candidate[]>();
    for (const [deviceId, points] of byDevice) {
      const vehicleId = vehicleOf.get(deviceId);
      if (vehicleId === undefined) continue;
      byVehicle.set(vehicleId, [...(byVehicle.get(vehicleId) ?? []), ...screen(points, now, settings.retentionDays, refusedBy)]);
    }
    let stored = 0;
    let duplicates = 0;
    for (const [vehicleId, candidates] of byVehicle) {
      if (candidates.length === 0) continue;
      const tripId = await roadTripOf(database, vehicleId, now, settings.customerDays);
      const result = await storeForVehicle(database, { vehicleId, tripId, sourceKind: "DEVICE", sourceId: source.id }, candidates, now);
      stored += result.stored;
      duplicates += result.duplicates;
      refusedBy.jump += result.jumps;
    }
    return { stored, duplicates, unknown, unknownDeviceIds: unknownIds, refused: total(refusedBy), refusedBy };
  });
}
