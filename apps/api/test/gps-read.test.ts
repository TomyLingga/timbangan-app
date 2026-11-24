// Reading positions: the vehicle list with the last point, the track of a vehicle and of a trip, and who may see what.
// Staff with gps see everything; a transporter its own vehicles; a supplier the truck of its own incoming trip while the
// trip runs; a customer the truck serving its DO until the window after exit passed. Points are written straight
// into the tables here; the intake routes have their own tests.
import { describe, expect, it } from "vitest";
import { pruneGpsPositions } from "../src/gps/retention.js";
import { gpsApp, SEA } from "./helpers/gps.js";

const DAY = 86_400_000;

async function setup() {
  const context = await gpsApp();
  const { database, vehicle, trip, companies, clock } = context;
  const ago = (seconds: number) => new Date(clock.now().getTime() - seconds * 1000).toISOString();
  /** A stored point `secondsAgo` before now, `km` east of SEA. */
  const pos = (vehicleId: number, tripId: number | null, secondsAgo: number, km = 0) =>
    database.query(
      "insert into vehicle_positions (vehicle_id, trip_id, at, lat, lon, speed_kph, source_kind, received_at) values ($1, $2, $3::timestamptz, $4, $5, 30, 'PHONE', $3::timestamptz)",
      [vehicleId, tripId, ago(secondsAgo), SEA.lat, SEA.lon + km / 109.6],
    );
  const last = (vehicleId: number, tripId: number | null, secondsAgo: number, km = 0) =>
    database.query(
      "insert into vehicle_last_positions (vehicle_id, trip_id, at, lat, lon, speed_kph, source_kind, received_at) values ($1, $2, $3::timestamptz, $4, $5, 30, 'PHONE', $3::timestamptz)",
      [vehicleId, tripId, ago(secondsAgo), SEA.lat, SEA.lon + km / 109.6],
    );

  // V1 of transporter1 on its way to supplier1's incoming trip T1; two points before the trip, two on it
  const v1 = await vehicle("ZZ 3101 GA", companies.transporter1);
  const t1 = await trip({ direction: "IN", partnerId: companies.supplier1, vehicleId: v1, status: "ISSUED" });
  await pos(v1, null, 3600, 0);
  await pos(v1, t1, 1800, 5);
  await pos(v1, t1, 600, 8);
  await pos(v1, null, 60, 9);
  await last(v1, null, 60, 9);
  // V2 of transporter2 left the plant a day ago with customer1's goods (T2)
  const v2 = await vehicle("ZZ 3102 GA", companies.transporter2);
  const t2 = await trip({ direction: "OUT", partnerId: companies.customer1, vehicleId: v2, status: "COMPLETED", exitedAt: "2026-11-19T03:00:00Z", transporterId: companies.transporter2 });
  await pos(v2, t2, 7200, 20);
  await pos(v2, t2, 2400, 40);
  await last(v2, t2, 2400, 40);
  // V3 of transporter1 left four days ago for customer1 (T3): the window has passed
  const v3 = await vehicle("ZZ 3103 GA", companies.transporter1);
  const t3 = await trip({ direction: "OUT", partnerId: companies.customer1, vehicleId: v3, status: "COMPLETED", exitedAt: "2026-11-16T03:00:00Z" });
  await pos(v3, t3, 3 * 86_400, 60);
  await last(v3, t3, 3 * 86_400, 60);
  // V4 of transporter2: supplier1's incoming trip T4 is completed
  const v4 = await vehicle("ZZ 3104 GA", companies.transporter2);
  const t4 = await trip({ direction: "IN", partnerId: companies.supplier1, vehicleId: v4, status: "COMPLETED", transporterId: companies.transporter2 });
  await pos(v4, t4, 5000, 2);
  await last(v4, t4, 5000, 2);
  // V5 without owner or trip
  const v5 = await vehicle("ZZ 3105 GA");
  await pos(v5, null, 120, 1);
  await last(v5, null, 120, 1);

  const list = async (user: string, query = "") => {
    const response = await context.call("GET", `/api/gps/vehicles${query}`, user);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { items: { vehicle: { id: number; plateDisplay: string }; last: { at: string }; trip: { id: number } | null }[]; total: number };
  };
  const plates = async (user: string, query = "") => (await list(user, query)).items.map((item) => item.vehicle.plateDisplay);
  const track = async (user: string, url: string) => context.call("GET", url, user);
  return { ...context, ago, pos, last, v1, v2, v3, v4, v5, t1, t2, t3, t4, list, plates, track };
}

describe("GET /api/gps/vehicles", () => {
  it("shows staff every vehicle with a last position, with its trip and the time since", async () => {
    const { list, v2, t2, companies, ago } = await setup();
    const body = await list("lihat");
    expect(body.total).toBe(5);
    expect(body.items.map((item) => item.vehicle.plateDisplay)).toEqual(["ZZ 3101 GA", "ZZ 3102 GA", "ZZ 3103 GA", "ZZ 3104 GA", "ZZ 3105 GA"]);
    expect(body.items[1]).toEqual({
      vehicle: { id: v2, plateNo: "ZZ3102GA", plateDisplay: "ZZ 3102 GA", vehicleType: { code: "TANGKI", name: expect.any(String) }, owner: { id: companies.transporter2, name: "PT Angkutan Contoh Dua" } },
      last: { at: ago(2400), lat: SEA.lat, lon: expect.closeTo(SEA.lon + 40 / 109.6, 6), speedKph: 30, headingDeg: null, accuracyM: null, sourceKind: "PHONE" },
      minutesSince: 40,
      trip: {
        id: t2, tripNo: expect.stringMatching(/^TRIP-GPS-/), spjNo: expect.stringMatching(/^SPJ-GPS-/), direction: "OUT", status: "COMPLETED",
        partner: { id: companies.customer1, name: "PT Pembeli Contoh Satu" }, doNos: [expect.stringMatching(/^DO-GPS-/)], contractNos: [expect.stringMatching(/^KTR-GPS-/)],
      },
      distanceToPlantKm: null,
    });
    // the trip of V3 left the window, V4's trip is closed, V5 has none
    expect(body.items.slice(2).map((item) => item.trip)).toEqual([null, null, null]);
  });

  it("gives the distance to the plant once its location is set", async () => {
    const { list, database } = await setup();
    await database.query("update settings set value = $1::jsonb where key = 'plant_location'", [JSON.stringify(SEA)]);
    const items = (await list("lihat")).items as unknown as { distanceToPlantKm: number }[];
    expect(items[1]?.distanceToPlantKm).toBeCloseTo(40, 0);
    expect(items[4]?.distanceToPlantKm).toBeCloseTo(1, 0);
  });

  it("filters by plate, trip state and how long a vehicle has been silent, and pages", async () => {
    const { plates, list } = await setup();
    expect(await plates("lihat", "?q=zz3102")).toEqual(["ZZ 3102 GA"]);
    expect(await plates("lihat", "?q=3101%20ga")).toEqual(["ZZ 3101 GA"]);
    expect(await plates("lihat", "?tripState=ISSUED")).toEqual(["ZZ 3101 GA"]);
    expect(await plates("lihat", "?tripState=COMPLETED")).toEqual(["ZZ 3102 GA"]);
    expect(await plates("lihat", "?staleMinutes=30")).toEqual(["ZZ 3102 GA", "ZZ 3103 GA", "ZZ 3104 GA"]);
    const page = await list("lihat", "?limit=2&offset=2");
    expect(page.total).toBe(5);
    expect(page.items.map((item) => item.vehicle.plateDisplay)).toEqual(["ZZ 3103 GA", "ZZ 3104 GA"]);
  });

  it("scopes partner accounts: own vehicles, and trucks on their own running trips only", async () => {
    const { plates, list, ago, t1 } = await setup();
    expect(await plates("angkut1")).toEqual(["ZZ 3101 GA", "ZZ 3103 GA"]);
    expect(await plates("angkut2")).toEqual(["ZZ 3102 GA", "ZZ 3104 GA"]);
    expect(await plates("pks1")).toEqual(["ZZ 3101 GA"]);
    expect(await plates("pks2")).toEqual([]);
    expect(await plates("beli1")).toEqual(["ZZ 3102 GA"]);
    expect(await plates("beli2")).toEqual([]);
    // the owner sees the newest point; the supplier only the newest point of its trip
    expect((await list("angkut1")).items[0]?.last.at).toBe(ago(60));
    const supplierView = (await list("pks1")).items[0];
    expect(supplierView?.last.at).toBe(ago(600));
    expect(supplierView?.trip?.id).toBe(t1);
    expect((await list("pks1")).total).toBe(1);
  });

  it("is closed to accounts without gps", async () => {
    const { call } = await setup();
    for (const user of ["angkut3", "logistik"]) expect((await call("GET", "/api/gps/vehicles", user)).statusCode, user).toBe(403);
    expect((await call("GET", "/api/gps/vehicles", null)).statusCode).toBe(401);
  });
});

describe("tracks", () => {
  it("give a vehicle's points in time order inside the range", async () => {
    const { track, v1, ago } = await setup();
    const response = await track("lihat", `/api/gps/vehicles/${v1}/track`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.vehicle).toEqual({ id: v1, plateDisplay: "ZZ 3101 GA" });
    expect(body.points.map((point: { at: string }) => point.at)).toEqual([ago(3600), ago(1800), ago(600), ago(60)]);
    expect(body.points[0]).toEqual({ at: ago(3600), lat: SEA.lat, lon: SEA.lon, speedKph: 30, headingDeg: null, accuracyM: null, sourceKind: "PHONE", tripId: null });
    expect(body).toMatchObject({ total: 4, thinned: false });
    const ranged = (await track("lihat", `/api/gps/vehicles/${v1}/track?from=${ago(2000)}&to=${ago(500)}`)).json();
    expect(ranged.points.map((point: { at: string }) => point.at)).toEqual([ago(1800), ago(600)]);
    expect((await track("lihat", `/api/gps/vehicles/${v1}/track?from=${ago(100)}&to=${ago(500)}`)).statusCode).toBe(400);
  });

  it("give a trip's points", async () => {
    const { track, t2, ago } = await setup();
    const body = (await track("lihat", `/api/gps/trips/${t2}/track`)).json();
    expect(body.trip).toMatchObject({ id: t2, plateDisplay: "ZZ 3102 GA" });
    expect(body.points.map((point: { at: string }) => point.at)).toEqual([ago(7200), ago(2400)]);
  });

  it("are scoped like the list, and a partner gets the same 404 for a vehicle it may not see as for none at all", async () => {
    const { track, v1, v2, v3, v4, t1, t2, t3, t4, ago } = await setup();
    const ats = async (user: string, url: string) => {
      const response = await track(user, url);
      return response.statusCode === 200 ? response.json().points.map((point: { at: string }) => point.at) : response.statusCode;
    };
    // the supplier: only its running trip, only that trip's points
    expect(await ats("pks1", `/api/gps/vehicles/${v1}/track`)).toEqual([ago(1800), ago(600)]);
    expect(await ats("pks1", `/api/gps/trips/${t1}/track`)).toEqual([ago(1800), ago(600)]);
    expect(await ats("pks1", `/api/gps/vehicles/${v4}/track`)).toBe(404);
    expect(await ats("pks1", `/api/gps/trips/${t4}/track`)).toBe(404);
    expect(await ats("pks2", `/api/gps/vehicles/${v1}/track`)).toBe(404);
    expect(await ats("pks2", `/api/gps/trips/${t1}/track`)).toBe(404);
    // the customer: its DO's truck inside the window after exit
    expect(await ats("beli1", `/api/gps/vehicles/${v2}/track`)).toEqual([ago(7200), ago(2400)]);
    expect(await ats("beli1", `/api/gps/trips/${t2}/track`)).toEqual([ago(7200), ago(2400)]);
    expect(await ats("beli1", `/api/gps/vehicles/${v3}/track`)).toBe(404);
    expect(await ats("beli1", `/api/gps/trips/${t3}/track`)).toBe(404);
    expect(await ats("beli2", `/api/gps/trips/${t2}/track`)).toBe(404);
    // the transporter: everything of its own vehicles, nothing of others
    expect(await ats("angkut1", `/api/gps/vehicles/${v1}/track`)).toEqual([ago(3600), ago(1800), ago(600), ago(60)]);
    expect(await ats("angkut1", `/api/gps/trips/${t3}/track`)).toEqual([ago(3 * 86_400)]);
    expect(await ats("angkut1", `/api/gps/vehicles/${v2}/track`)).toBe(404);
    expect(await ats("angkut1", `/api/gps/trips/${t2}/track`)).toBe(404);
    expect(await ats("angkut2", `/api/gps/trips/${t1}/track`)).toBe(404);

    const hidden = await track("pks1", `/api/gps/vehicles/${v2}/track`);
    const missing = await track("pks1", "/api/gps/vehicles/999999/track");
    expect(hidden.json()).toEqual(missing.json());
    expect((await track("beli1", "/api/gps/trips/999999/track")).json()).toEqual((await track("beli1", `/api/gps/trips/${t3}/track`)).json());
  });

  it("are thinned to 2000 points, always keeping the first and the last", async () => {
    const { database, vehicle, track, clock } = await setup();
    const busy = await vehicle("ZZ 3109 GA");
    const start = clock.now().getTime() - 5000 * 10_000;
    await database.query(
      `insert into vehicle_positions (vehicle_id, at, lat, lon, source_kind)
       select $1, $2::timestamptz + g * interval '10 seconds', $3, $4, 'PHONE' from generate_series(0, 4999) as g`,
      [busy, new Date(start).toISOString(), SEA.lat, SEA.lon],
    );
    const body = (await track("lihat", `/api/gps/vehicles/${busy}/track?from=${new Date(start - 1).toISOString()}`)).json();
    expect(body.total).toBe(5000);
    expect(body.thinned).toBe(true);
    // every third point (5000 / 3) and the last one
    expect(body.points).toHaveLength(1668);
    expect(body.points[0].at).toBe(new Date(start).toISOString());
    expect(body.points.at(-1).at).toBe(new Date(start + 4999 * 10_000).toISOString());
    const times = body.points.map((point: { at: string }) => Date.parse(point.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));

    const small = (await track("lihat", `/api/gps/vehicles/${busy}/track?from=${new Date(start + 3000 * 10_000 - 1).toISOString()}`)).json();
    expect(small).toMatchObject({ total: 2000, thinned: false });
    expect(small.points).toHaveLength(2000);
  });
});

describe("vehicles list", () => {
  it("tells which vehicles carry an active tracker", async () => {
    const { call, v1, v2, source, attach } = await setup();
    const provider = await source();
    await attach(v1, provider.id, "ALAT-31");
    const items = (await call("GET", "/api/vehicles?q=zz310", "logistik")).json().items as { id: number; hasGps: boolean }[];
    expect(items.find((item) => item.id === v1)?.hasGps).toBe(true);
    expect(items.find((item) => item.id === v2)?.hasGps).toBe(false);
  });
});

describe("retention", () => {
  it("deletes points older than the setting, never the last position, and forgets old unknown devices", async () => {
    const { database, pos, v5, clock } = await setup();
    await pos(v5, null, 91 * 86_400, 3);
    await pos(v5, null, 89 * 86_400, 3);
    await database.query("update vehicle_last_positions set at = $1::timestamptz where vehicle_id = $2", [new Date(clock.now().getTime() - 120 * DAY).toISOString(), v5]);
    const [source] = await database.query<{ id: number }>("insert into gps_sources (name, kind) values ('Penyedia Lama', 'PROVIDER') returning id::int as id");
    await database.query(
      `insert into gps_unknown_devices (source_id, device_id, first_seen_at, last_seen_at, last_point_at, point_count)
       values ($1, 'LAMA', $2::timestamptz, $2::timestamptz, $2::timestamptz, 1), ($1, 'BARU', $3::timestamptz, $3::timestamptz, $3::timestamptz, 1)`,
      [source?.id, new Date(clock.now().getTime() - 100 * DAY).toISOString(), clock.now().toISOString()],
    );
    const before = Number((await database.query<{ n: number }>("select count(*)::int as n from vehicle_positions"))[0]?.n);
    expect(await pruneGpsPositions(database, clock.now())).toEqual({ positions: 1, unknownDevices: 1 });
    expect(await database.query("select count(*)::int as n from vehicle_positions")).toEqual([{ n: before - 1 }]);
    expect(await database.query("select count(*)::int as n from vehicle_positions where at < $1::timestamptz", [new Date(clock.now().getTime() - 90 * DAY).toISOString()])).toEqual([{ n: 0 }]);
    expect(await database.query("select count(*)::int as n from vehicle_last_positions where vehicle_id = $1", [v5])).toEqual([{ n: 1 }]);
    expect(await database.query("select device_id from gps_unknown_devices")).toEqual([{ device_id: "BARU" }]);
  });
});
