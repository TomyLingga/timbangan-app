// Reading positions (module gps, VIEW): vehicles with their last point, and tracks. Who sees what is decided in SQL:
// staff see every vehicle; a partner account sees the vehicles its company owns (all their points), and a truck on a
// trip that concerns it while that trip is on the road (only the points of that trip): the supplier of an incoming
// registration until the trip is closed, the customer of a delivery order also until the window after exit passed.
// A partner gets the same 404 for a vehicle it may not see as for one that does not exist.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { type Account, accountOf, type Guards } from "../auth/guard.js";
import { TRIP_STATUSES } from "../db/schema.js";
import type { SqlRunner } from "../db/client.js";
import { invalid, notFound } from "../errors.js";
import { idNumber, idParams, lettersAndDigits, searchParam } from "../http.js";
import { destinationsOfTrips, withDistance } from "./destinations.js";
import { distanceKm } from "./geo.js";
import { gpsSettings, onTheRoad, ROAD_ORDER, SqlParams } from "./trips.js";

/** A track never has more points than this; longer ones keep every n-th point, the first and the last. */
export const MAX_TRACK_POINTS = 2000;
const DEFAULT_TRACK_MS = 86_400_000;
const PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const LIMIT_MESSAGE = "Limit harus angka mulai dari 1.";
const OFFSET_MESSAGE = "Offset harus angka mulai dari 0.";
const STALE_MESSAGE = "staleMinutes harus angka bulat mulai dari 1.";
/** Separates the numbers string_agg joins, so a number with a comma stays whole. */
const SEPARATOR = "\u001f";

const listQuery = z.object({
  q: searchParam,
  tripState: z.enum(TRIP_STATUSES, `Status trip harus salah satu dari ${TRIP_STATUSES.join(", ")}.`).optional(),
  staleMinutes: z.coerce.number(STALE_MESSAGE).int(STALE_MESSAGE).min(1, STALE_MESSAGE).max(525_600, STALE_MESSAGE).optional(),
  limit: z.coerce.number(LIMIT_MESSAGE).int(LIMIT_MESSAGE).min(1, LIMIT_MESSAGE).default(PAGE_SIZE).transform((value) => Math.min(value, MAX_PAGE_SIZE)),
  offset: z.coerce.number(OFFSET_MESSAGE).int(OFFSET_MESSAGE).min(0, OFFSET_MESSAGE).default(0),
});
const TIME_MESSAGE = "harus berformat ISO 8601 dengan zona waktu, misalnya 2026-11-20T03:00:00Z.";
const rangeQuery = z.object({
  from: z.iso.datetime({ offset: true, message: `Waktu awal ${TIME_MESSAGE}` }).optional(),
  to: z.iso.datetime({ offset: true, message: `Waktu akhir ${TIME_MESSAGE}` }).optional(),
});
const tripParams = z.object({ tripId: idNumber });

/** Who reads: staff, or the company of a partner account. */
type Scope = { staff: true } | { staff: false; partnerId: number };
const scopeOf = (account: Account): Scope => (account.kind === "INTERNAL" ? { staff: true } : { staff: false, partnerId: account.partner?.id ?? -1 });

/** SQL: vehicle `v` is owned by the partner (always true for staff). */
function ownsSql(params: SqlParams, scope: Scope, v = "v"): string {
  return scope.staff ? "true" : `coalesce(${v}.owner_partner_id = ${params.add(scope.partnerId, "bigint")}, false)`;
}

/** SQL: trip `t` (registration `r`) concerns the partner as supplier of the registration or customer of a DO. */
function concernsSql(params: SqlParams, scope: Scope, t = "t", r = "r"): string {
  if (scope.staff) return "true";
  const own = params.add(scope.partnerId, "bigint");
  return `((${r}.direction = 'IN' and ${r}.partner_id = ${own})
    or (${r}.direction = 'OUT' and exists (
      select 1 from trip_allocations ta
      join registration_allocations ra on ra.id = ta.registration_allocation_id
      join delivery_orders d on d.id = ra.delivery_order_id
      where ta.trip_id = ${t}.id and d.partner_id = ${own})))`;
}

interface PointRow {
  at: Date;
  lat: number;
  lon: number;
  speed_kph: number | null;
  heading_deg: number | null;
  accuracy_m: number | null;
  source_kind: string;
}

const pointView = (row: PointRow) => ({
  at: new Date(row.at).toISOString(),
  lat: Number(row.lat),
  lon: Number(row.lon),
  speedKph: row.speed_kph === null ? null : Number(row.speed_kph),
  headingDeg: row.heading_deg === null ? null : Number(row.heading_deg),
  accuracyM: row.accuracy_m === null ? null : Number(row.accuracy_m),
  sourceKind: row.source_kind,
});

const split = (text: string | null) => (text ? text.split(SEPARATOR) : []);

/** The points matching `where` (on vehicle_positions p) in time order, thinned to MAX_TRACK_POINTS. */
async function thinnedTrack(db: SqlRunner, where: string, params: SqlParams) {
  const rows = await db.query<PointRow & { trip_id: number | null; n: number }>(
    `select x.at, x.lat, x.lon, x.speed_kph, x.heading_deg, x.accuracy_m, x.source_kind, x.trip_id::float8 as trip_id, x.n::int as n
     from (
       select p.at, p.lat, p.lon, p.speed_kph, p.heading_deg, p.accuracy_m, p.source_kind, p.trip_id,
              row_number() over (order by p.at) as rn, count(*) over () as n
       from vehicle_positions p where ${where}
     ) x
     where x.n <= ${MAX_TRACK_POINTS} or (x.rn - 1) % greatest(1, ceil((x.n - 1) / ${MAX_TRACK_POINTS - 2}.0))::bigint = 0 or x.rn = x.n
     order by x.at`,
    params.values,
  );
  const total = rows.length > 0 ? Number(rows[0]?.n) : 0;
  return {
    points: rows.map((row) => ({ ...pointView(row), tripId: row.trip_id === null ? null : Number(row.trip_id) })),
    total,
    thinned: total > MAX_TRACK_POINTS,
  };
}

export function registerGpsReadRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const database = context.database;
  const orm = database.db;
  const readers = { preHandler: [guards.authenticate, guards.requirePermission("gps", "VIEW")] };

  app.get("/api/gps/vehicles", readers, async (request) => {
    const query = listQuery.parse(request.query);
    const scope = scopeOf(accountOf(request));
    const now = context.now();
    const settings = await gpsSettings(orm);
    const params = new SqlParams();
    const owns = ownsSql(params, scope);
    const lastRoad = onTheRoad(params, now, settings.customerDays);
    const lastConcerns = concernsSql(params, scope);
    const tripRoad = onTheRoad(params, now, settings.customerDays);
    const tripConcerns = concernsSql(params, scope);
    const filters: string[] = [];
    const plate = query.q ? lettersAndDigits(query.q) : "";
    if (plate) filters.push(`v.plate_no like ${params.add(`%${plate}%`, "text")}`);
    if (query.tripState) filters.push(`ct.status = ${params.add(query.tripState, "text")}`);
    if (query.staleMinutes) filters.push(`lp.at <= ${params.add(now, "timestamptz")} - make_interval(mins => ${params.add(query.staleMinutes, "int")})`);
    const from = `
      from vehicles v
      join vehicle_types vt on vt.code = v.vehicle_type_code
      left join partners o on o.id = v.owner_partner_id
      join lateral (
        (select l.at, l.lat, l.lon, l.speed_kph, l.heading_deg, l.accuracy_m, l.source_kind
         from vehicle_last_positions l where l.vehicle_id = v.id and ${owns})
        union all
        (select p.at, p.lat, p.lon, p.speed_kph, p.heading_deg, p.accuracy_m, p.source_kind
         from vehicle_positions p join trips t on t.id = p.trip_id join registrations r on r.id = t.registration_id
         where p.vehicle_id = v.id and not ${owns} and ${lastRoad} and ${lastConcerns})
        order by at desc limit 1
      ) lp on true
      left join lateral (
        select t.id, t.trip_no, t.status, r.direction, r.partner_id, rp.name as partner_name,
               (select s.spj_no from spj_documents s where s.trip_id = t.id and s.revoked_at is null order by s.issued_at desc limit 1) as spj_no,
               (select string_agg(distinct ra.do_no, chr(31)) from trip_allocations ta join registration_allocations ra on ra.id = ta.registration_allocation_id
                where ta.trip_id = t.id) as do_nos,
               (select string_agg(distinct ra.contract_no, chr(31)) from trip_allocations ta join registration_allocations ra on ra.id = ta.registration_allocation_id
                where ta.trip_id = t.id) as contract_nos
        from trips t join registrations r on r.id = t.registration_id join partners rp on rp.id = r.partner_id
        where t.vehicle_id = v.id and ${tripRoad} and (${owns} or ${tripConcerns})
        order by ${ROAD_ORDER()} limit 1
      ) ct on true
      ${filters.length ? `where ${filters.join(" and ")}` : ""}`;
    const [counted] = await database.query<{ n: number }>(`select count(*)::int as n ${from}`, params.values);
    const limit = params.add(query.limit, "int");
    const offset = params.add(query.offset, "int");
    const rows = await database.query<
      PointRow & {
        id: number;
        plate_no: string;
        plate_display: string;
        vehicle_type_code: string;
        type_name: string;
        owner_id: number | null;
        owner_name: string | null;
        trip_id: number | null;
        trip_no: string | null;
        spj_no: string | null;
        status: string | null;
        direction: string | null;
        partner_id: number | null;
        partner_name: string | null;
        do_nos: string | null;
        contract_nos: string | null;
      }
    >(
      `select v.id::float8 as id, v.plate_no, v.plate_display, v.vehicle_type_code, vt.name as type_name, o.id::float8 as owner_id, o.name as owner_name,
              lp.at, lp.lat, lp.lon, lp.speed_kph, lp.heading_deg, lp.accuracy_m, lp.source_kind,
              ct.id::float8 as trip_id, ct.trip_no, ct.spj_no, ct.status, ct.direction, ct.partner_id::float8 as partner_id, ct.partner_name, ct.do_nos, ct.contract_nos
       ${from}
       order by v.plate_no, v.id limit ${limit} offset ${offset}`,
      params.values,
    );
    const destinations = await destinationsOfTrips(
      orm,
      rows.flatMap((row) => (row.trip_id === null ? [] : [Number(row.trip_id)])),
    );
    return {
      items: rows.map((row) => {
        const last = pointView(row);
        return {
          vehicle: {
            id: Number(row.id),
            plateNo: row.plate_no,
            plateDisplay: row.plate_display,
            vehicleType: { code: row.vehicle_type_code, name: row.type_name },
            owner: row.owner_id !== null && row.owner_name !== null ? { id: Number(row.owner_id), name: row.owner_name } : null,
          },
          last,
          minutesSince: Math.max(0, Math.floor((now.getTime() - Date.parse(last.at)) / 60_000)),
          trip:
            row.trip_id === null
              ? null
              : {
                  id: Number(row.trip_id),
                  tripNo: row.trip_no,
                  spjNo: row.spj_no,
                  direction: row.direction,
                  status: row.status,
                  partner: { id: Number(row.partner_id), name: row.partner_name },
                  doNos: split(row.do_nos),
                  contractNos: split(row.contract_nos),
                  destinations: withDistance(destinations.get(Number(row.trip_id)) ?? [], last),
                },
          distanceToPlantKm: settings.plant ? Math.round(distanceKm(settings.plant, last) * 10) / 10 : null,
        };
      }),
      total: Number(counted?.n ?? 0),
    };
  });

  app.get("/api/gps/vehicles/:id/track", readers, async (request) => {
    const { id } = idParams.parse(request.params);
    const range = rangeQuery.parse(request.query);
    const to = range.to ? new Date(range.to) : context.now();
    const from = range.from ? new Date(range.from) : new Date(to.getTime() - DEFAULT_TRACK_MS);
    if (from.getTime() >= to.getTime()) throw invalid("from", "Waktu awal harus sebelum waktu akhir.");
    const scope = scopeOf(accountOf(request));
    const now = context.now();
    const { customerDays } = await gpsSettings(orm);
    // the trips through which a partner that does not own the vehicle may see it
    const sharedTrips = (params: SqlParams, vehicle: string) =>
      `select t.id from trips t join registrations r on r.id = t.registration_id
       where t.vehicle_id = ${vehicle} and ${onTheRoad(params, now, customerDays)} and ${concernsSql(params, scope)}`;
    const params = new SqlParams();
    const owns = ownsSql(params, scope);
    const [vehicle] = await database.query<{ plate_display: string; owns: boolean; shared: boolean }>(
      `select v.plate_display, ${owns} as owns, exists (${sharedTrips(params, "v.id")}) as shared from vehicles v where v.id = ${params.add(id, "bigint")}`,
      params.values,
    );
    if (!vehicle || (!vehicle.owns && !vehicle.shared)) throw notFound("Kendaraan");
    // every placeholder must appear in the statement, so the points get their own parameters
    const pointParams = new SqlParams();
    const where = [
      `p.vehicle_id = ${pointParams.add(id, "bigint")}`,
      `p.at >= ${pointParams.add(from, "timestamptz")}`,
      `p.at <= ${pointParams.add(to, "timestamptz")}`,
      ...(vehicle.owns ? [] : [`p.trip_id in (${sharedTrips(pointParams, "p.vehicle_id")})`]),
    ];
    return {
      vehicle: { id, plateDisplay: vehicle.plate_display },
      from: from.toISOString(),
      to: to.toISOString(),
      ...(await thinnedTrack(database, where.join(" and "), pointParams)),
    };
  });

  app.get("/api/gps/trips/:tripId/track", readers, async (request) => {
    const { tripId } = tripParams.parse(request.params);
    const scope = scopeOf(accountOf(request));
    const now = context.now();
    const { customerDays } = await gpsSettings(orm);
    const params = new SqlParams();
    const trip = params.add(tripId, "bigint");
    const owns = ownsSql(params, scope);
    const road = onTheRoad(params, now, customerDays);
    const concerns = concernsSql(params, scope);
    const [row] = await database.query<{ trip_no: string | null; plate_display: string | null; direction: string; status: string; allowed: boolean }>(
      `select t.trip_no, v.plate_display, r.direction, t.status, (${owns} or (${road} and ${concerns})) as allowed
       from trips t join registrations r on r.id = t.registration_id left join vehicles v on v.id = t.vehicle_id
       where t.id = ${trip}`,
      params.values,
    );
    if (!row?.allowed) throw notFound("Trip");
    const pointParams = new SqlParams();
    const track = await thinnedTrack(database, `p.trip_id = ${pointParams.add(tripId, "bigint")}`, pointParams);
    // the distance is measured from the last point of this trip, the newest point the reader may see
    const last = track.points.at(-1) ?? null;
    const destinations = (await destinationsOfTrips(orm, [tripId])).get(tripId) ?? [];
    return {
      trip: {
        id: tripId,
        tripNo: row.trip_no,
        plateDisplay: row.plate_display,
        direction: row.direction,
        status: row.status,
        destinations: withDistance(destinations, last),
      },
      ...track,
    };
  });
}
