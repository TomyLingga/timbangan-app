// Sharing the driver's phone location. The page the QR code on the SPJ opens calls two routes without an account:
// GET /api/gps/share/:token (the plate and whether sharing is open) and POST /api/gps/share/:token/positions.
// Staff with gps EDIT can revoke a trip's link or give it a new one.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { accountOf, type Guards } from "../auth/guard.js";
import { writeAudit } from "../audit.js";
import type { SqlRunner } from "../db/client.js";
import { AppError, invalidState, notFound, violatedUnique } from "../errors.js";
import { idNumber, PLANT_TIME_ZONE } from "../http.js";
import { destinationsOfTrips } from "./destinations.js";
import { RateLimiter } from "./geo.js";
import { noRefusal, pointFields, screen, storeForVehicle, total } from "./ingest.js";
import { rateLimited } from "./intake-routes.js";
import { activeShareToken, hadShareLink, hashShareToken, looksLikeShareToken, replaceShareLink, revokeShareLink, shareUrlFor } from "./share.js";
import { gpsSettings, onTheRoad, SqlParams } from "./trips.js";

/** Requests one link may send in a minute: the page sends every few seconds. */
export const PHONE_REQUESTS_PER_MINUTE = 20;
export const MAX_PHONE_POINTS = 60;
const PHONE_BODY_LIMIT = 32 * 1024;
const DAY_MS = 86_400_000;

const phoneBody = z.object({
  points: z
    .array(z.object(pointFields), "points harus berupa daftar titik.")
    .min(1, "Kirim minimal satu titik.")
    .max(MAX_PHONE_POINTS, `Paling banyak ${MAX_PHONE_POINTS} titik per kiriman.`),
});
const tokenParams = z.object({ token: z.string() });
const tripParams = z.object({ tripId: idNumber });

const CLOSED_TEXT = "Berbagi lokasi untuk perjalanan ini sudah ditutup.";
const sharingClosed = () => new AppError(409, "SHARING_CLOSED", CLOSED_TEXT);
const unknownLink = () => notFound("Tautan berbagi lokasi");

interface SharedTrip {
  linkId: number;
  tripId: number;
  vehicleId: number | null;
  plateDisplay: string | null;
  direction: "IN" | "OUT";
  status: string;
  exitedAt: Date | null;
  open: boolean;
}

/** Whether the trip is on the road now: sharing is open and the customer may follow it. */
async function tripIsOnTheRoad(db: SqlRunner, tripId: number, now: Date, customerDays: number): Promise<boolean | null> {
  const params = new SqlParams();
  const id = params.add(tripId, "bigint");
  const road = onTheRoad(params, now, customerDays);
  const [row] = await db.query<{ open: boolean }>(`select (${road}) as open from trips t join registrations r on r.id = t.registration_id where t.id = ${id}`, params.values);
  return row ? row.open === true : null;
}

/**
 * The share URL printed on the trip's SPJ, or null when the trip has no active link. A trip issued before links
 * existed gets one here while it is on the road; a link staff revoked is not made again.
 */
export async function spjShareUrl(context: AppContext, tripId: number): Promise<string | null> {
  const orm = context.database.db;
  const secret = context.config.jwtSecret;
  let token = await activeShareToken(orm, secret, tripId);
  if (token === null && !(await hadShareLink(orm, tripId))) {
    const now = context.now();
    const { customerDays } = await gpsSettings(orm);
    if (await tripIsOnTheRoad(context.database, tripId, now, customerDays)) {
      try {
        await replaceShareLink(orm, tripId, null, now);
      } catch (error) {
        // printed twice at the same moment: the other request made it
        if (violatedUnique(error) !== "trip_share_links_active_key") throw error;
      }
      token = await activeShareToken(orm, secret, tripId);
    }
  }
  return token === null ? null : shareUrlFor(context.config.webOrigin, token);
}

const dateFormat = new Intl.DateTimeFormat("id-ID", { timeZone: PLANT_TIME_ZONE, day: "numeric", month: "long", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat("id-ID", { timeZone: PLANT_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** Until when sharing is open, in words the driver reads, and as a time when it is known. */
function sharingWindow(trip: SharedTrip, customerDays: number): { open: boolean; until: string; untilAt: string | null } {
  if (!trip.open) return { open: false, until: CLOSED_TEXT, untilAt: null };
  if (trip.status === "COMPLETED" && trip.exitedAt) {
    const end = new Date(new Date(trip.exitedAt).getTime() + customerDays * DAY_MS);
    return { open: true, until: `Sampai ${dateFormat.format(end)} pukul ${timeFormat.format(end)} WIB.`, untilAt: end.toISOString() };
  }
  if (trip.direction === "OUT") return { open: true, until: `Sampai ${customerDays} hari setelah truk keluar dari pabrik.`, untilAt: null };
  return { open: true, until: "Sampai truk selesai dan keluar dari pabrik.", untilAt: null };
}

export function registerGpsShareRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const database = context.database;
  const orm = database.db;
  const limiter = new RateLimiter(context.now, PHONE_REQUESTS_PER_MINUTE, 60_000);
  const editors = { preHandler: [guards.authenticate, guards.requireInternal, guards.requirePermission("gps", "EDIT")] };

  /** The trip behind an active link; 404 for anything else. */
  async function sharedTrip(rawToken: string, now: Date, customerDays: number): Promise<SharedTrip> {
    if (!looksLikeShareToken(rawToken)) throw unknownLink();
    const params = new SqlParams();
    const hash = params.add(hashShareToken(rawToken), "text");
    const road = onTheRoad(params, now, customerDays);
    const [row] = await database.query<{
      link_id: number;
      trip_id: number;
      vehicle_id: number | null;
      plate_display: string | null;
      direction: "IN" | "OUT";
      status: string;
      exited_at: Date | null;
      open: boolean;
    }>(
      `select l.id::float8 as link_id, t.id::float8 as trip_id, t.vehicle_id::float8 as vehicle_id, v.plate_display, r.direction, t.status, t.exited_at,
              (${road}) as open
       from trip_share_links l
       join trips t on t.id = l.trip_id
       join registrations r on r.id = t.registration_id
       left join vehicles v on v.id = t.vehicle_id
       where l.token_hash = ${hash} and l.revoked_at is null`,
      params.values,
    );
    if (!row) throw unknownLink();
    return {
      linkId: Number(row.link_id),
      tripId: Number(row.trip_id),
      vehicleId: row.vehicle_id === null ? null : Number(row.vehicle_id),
      plateDisplay: row.plate_display,
      direction: row.direction,
      status: row.status,
      exitedAt: row.exited_at,
      open: row.open === true && row.vehicle_id !== null,
    };
  }

  app.get("/api/gps/share/:token", async (request) => {
    const { token } = tokenParams.parse(request.params);
    const { customerDays } = await gpsSettings(orm);
    const trip = await sharedTrip(token, context.now(), customerDays);
    // nothing else of the trip: the page is open to whoever holds the paper. The pinned destinations let the driver
    // open the place in a maps app; once sharing is closed they are not given any more.
    const destinations = trip.open ? ((await destinationsOfTrips(orm, [trip.tripId])).get(trip.tripId) ?? []) : [];
    return { plateDisplay: trip.plateDisplay, ...sharingWindow(trip, customerDays), destinations };
  });

  app.post("/api/gps/share/:token/positions", { bodyLimit: PHONE_BODY_LIMIT }, async (request) => {
    const { token } = tokenParams.parse(request.params);
    const now = context.now();
    const settings = await gpsSettings(orm);
    const trip = await sharedTrip(token, now, settings.customerDays);
    if (!limiter.take(String(trip.linkId))) throw rateLimited();
    if (!trip.open || trip.vehicleId === null) throw sharingClosed();
    const body = phoneBody.parse(request.body);
    const refusedBy = noRefusal();
    const candidates = screen(body.points, now, settings.retentionDays, refusedBy);
    const result = await storeForVehicle(database, { vehicleId: trip.vehicleId, tripId: trip.tripId, sourceKind: "PHONE", sourceId: null }, candidates, now);
    refusedBy.jump += result.jumps;
    return { stored: result.stored, duplicates: result.duplicates, refused: total(refusedBy), refusedBy };
  });

  app.post("/api/gps/trips/:tripId/share-link/revoke", editors, async (request) => {
    const { tripId } = tripParams.parse(request.params);
    const actor = accountOf(request).id;
    const now = context.now();
    const { customerDays } = await gpsSettings(orm);
    if ((await tripIsOnTheRoad(database, tripId, now, customerDays)) === null) throw notFound("Trip");
    await orm.transaction(async (tx) => {
      if (!(await revokeShareLink(tx, tripId, actor, now))) throw invalidState("Tautan berbagi lokasi perjalanan ini sudah dicabut.");
      await writeAudit(tx, request, now, { action: "GPS_SHARE_LINK_REVOKED", entityType: "trip", entityId: tripId, before: { shared: true }, after: { shared: false } });
    });
    return { shareUrl: null };
  });

  app.post("/api/gps/trips/:tripId/share-link/renew", editors, async (request) => {
    const { tripId } = tripParams.parse(request.params);
    const actor = accountOf(request).id;
    const now = context.now();
    const { customerDays } = await gpsSettings(orm);
    const open = await tripIsOnTheRoad(database, tripId, now, customerDays);
    if (open === null) throw notFound("Trip");
    if (!open) throw invalidState("Perjalanan ini sudah selesai; lokasinya tidak bisa dibagikan lagi.");
    const token = await orm.transaction(async (tx) => {
      await replaceShareLink(tx, tripId, actor, now);
      await writeAudit(tx, request, now, { action: "GPS_SHARE_LINK_RENEWED", entityType: "trip", entityId: tripId, before: null, after: { shared: true } });
      return activeShareToken(tx, context.config.jwtSecret, tripId);
    });
    return { shareUrl: token === null ? null : shareUrlFor(context.config.webOrigin, token) };
  });
}
