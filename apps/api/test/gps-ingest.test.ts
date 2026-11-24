// Positions sent by tracker devices (POST /api/gps/positions with X-Tracker-Key), and the masters behind it: sources
// with their key, trackers that attach a device id to a vehicle, and the device ids no tracker knows.
import { describe, expect, it } from "vitest";
import { hashStationKey } from "../src/stations/keys.js";
import { gpsApp, SEA } from "./helpers/gps.js";

const MINUTE = 60_000;
const DAY = 86_400_000;
const NO_REFUSAL = { range: 0, future: 0, tooOld: 0, jump: 0 };

/** A point `seconds` after now, `km` east of SEA (about 1.1 km per 0.01 degree there). */
const point = (deviceId: string, atIso: string, km = 0, extra: object = {}) => ({ deviceId, at: atIso, lat: SEA.lat, lon: SEA.lon + km / 109.6, ...extra });

async function setup() {
  const context = await gpsApp();
  const { vehicle, source, attach, companies } = context;
  const truck = await vehicle("ZZ 1101 GA", companies.transporter1);
  const other = await vehicle("ZZ 1102 GA", companies.transporter2);
  const provider = await source("Penyedia Contoh Satu");
  await attach(truck, provider.id, "ALAT-01");
  await attach(other, provider.id, "ALAT-02");
  return { ...context, truck, other, provider };
}

describe("tracker sources", () => {
  it("shows the key once and keeps only its hash", async () => {
    const { call, database, provider } = await setup();
    expect(provider.key).toMatch(/^gs\d+\.[A-Za-z0-9_-]{43}$/);
    const [row] = await database.query<{ key_hash: string }>("select key_hash from gps_sources where id = $1", [provider.id]);
    expect(row?.key_hash).toBe(hashStationKey(provider.key));
    const listed = (await call("GET", "/api/gps/sources", "lacak")).json();
    expect(listed.items).toEqual([
      {
        id: provider.id, name: "Penyedia Contoh Satu", kind: "PROVIDER", isActive: true, hasKey: true, keyCreatedAt: "2026-11-20T03:00:00.000Z", lastSeenAt: null,
        trackers: 2,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain(provider.key.slice(-43));
  });

  it("refuses requests without a valid key, with a rotated key and from a deactivated source", async () => {
    const { send, call, provider, at } = await setup();
    const body = [point("ALAT-01", at(0))];
    for (const key of ["", "gs1.short", `gs999.${"a".repeat(43)}`, provider.key.slice(0, -1) + (provider.key.endsWith("a") ? "b" : "a")]) {
      const refused = await send(key, body);
      expect(refused.statusCode, key).toBe(401);
      expect(refused.json().error).toEqual({ code: "TRACKER_UNAUTHENTICATED", message: "Kunci kiriman tidak valid." });
    }
    const rotated = await call("POST", `/api/gps/sources/${provider.id}/key`, "lacak");
    expect(rotated.statusCode).toBe(200);
    const newKey = rotated.json().key as string;
    expect(newKey).not.toBe(provider.key);
    expect((await send(provider.key, body)).statusCode).toBe(401);
    expect((await send(newKey, body)).statusCode).toBe(200);

    expect((await call("POST", `/api/gps/sources/${provider.id}/deactivate`, "lacak")).json().source.isActive).toBe(false);
    expect((await send(newKey, [point("ALAT-01", at(10))])).statusCode).toBe(401);
  });

  it("needs gps EDIT and a staff account for every master route", async () => {
    const { call, provider, truck } = await setup();
    const routes: [("GET" | "POST"), string, object?][] = [
      ["GET", "/api/gps/sources"],
      ["POST", "/api/gps/sources", { name: "Penyedia Lain", kind: "DEVICE" }],
      ["POST", `/api/gps/sources/${provider.id}/key`],
      ["POST", `/api/gps/sources/${provider.id}/deactivate`],
      ["GET", `/api/gps/sources/${provider.id}/unknown-devices`],
      ["GET", "/api/gps/trackers"],
      ["POST", "/api/gps/trackers", { vehicleId: truck, sourceId: provider.id, deviceId: "ALAT-09" }],
      ["POST", "/api/gps/trackers/1/detach"],
    ];
    for (const [method, url, payload] of routes) {
      for (const user of ["lihat", "angkut1", "logistik"]) {
        const response = await call(method, url, user, payload);
        expect(response.statusCode, `${method} ${url} as ${user}`).toBe(403);
      }
    }
  });

  it("validates a new source", async () => {
    const { call } = await setup();
    const response = await call("POST", "/api/gps/sources", "lacak", { name: " ", kind: "SATELIT" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.fields.map((f: { field: string }) => f.field).sort()).toEqual(["kind", "name"]);
  });
});

describe("trackers", () => {
  it("attaches one device id per vehicle and one vehicle per device id of a source, and detaches", async () => {
    const { call, truck, other, provider, vehicle, companies, database } = await setup();
    const third = await vehicle("ZZ 1103 GA", companies.transporter1);
    const busyVehicle = await call("POST", "/api/gps/trackers", "lacak", { vehicleId: truck, sourceId: provider.id, deviceId: "ALAT-09" });
    expect(busyVehicle.statusCode).toBe(409);
    expect(busyVehicle.json().error).toEqual({ code: "DUPLICATE", message: "Kendaraan ZZ 1101 GA sudah memakai alat pelacak lain." });
    const busyDevice = await call("POST", "/api/gps/trackers", "lacak", { vehicleId: third, sourceId: provider.id, deviceId: "ALAT-02" });
    expect(busyDevice.statusCode).toBe(409);
    expect(busyDevice.json().error).toEqual({ code: "DUPLICATE", message: "Alat ALAT-02 sudah terpasang di kendaraan ZZ 1102 GA." });
    expect((await call("POST", "/api/gps/trackers", "lacak", { vehicleId: 999999, sourceId: provider.id, deviceId: "ALAT-09" })).statusCode).toBe(400);

    const listed = (await call("GET", `/api/gps/trackers?sourceId=${provider.id}`, "lacak")).json().items;
    expect(listed).toEqual([
      expect.objectContaining({ vehicle: { id: truck, plateDisplay: "ZZ 1101 GA" }, source: { id: provider.id, name: "Penyedia Contoh Satu" }, deviceId: "ALAT-01", isActive: true }),
      expect.objectContaining({ vehicle: { id: other, plateDisplay: "ZZ 1102 GA" }, deviceId: "ALAT-02", isActive: true }),
    ]);
    const trackerId = listed[1].id as number;
    const detached = await call("POST", `/api/gps/trackers/${trackerId}/detach`, "lacak");
    expect(detached.statusCode).toBe(200);
    expect(detached.json().tracker).toMatchObject({ id: trackerId, isActive: false, detachedAt: "2026-11-20T03:00:00.000Z" });
    expect((await call("POST", `/api/gps/trackers/${trackerId}/detach`, "lacak")).statusCode).toBe(409);
    expect((await call("POST", "/api/gps/trackers", "lacak", { vehicleId: third, sourceId: provider.id, deviceId: "ALAT-02" })).statusCode).toBe(201);
    expect(await database.query("select action from audit_log where entity_type = 'vehicle_tracker' order by id")).toEqual([
      { action: "GPS_TRACKER_ATTACHED" }, { action: "GPS_TRACKER_ATTACHED" }, { action: "GPS_TRACKER_DETACHED" }, { action: "GPS_TRACKER_ATTACHED" },
    ]);
  });
});

describe("POST /api/gps/positions", () => {
  it("stores the points of a known device, moves the last position and records when the source was seen", async () => {
    const { send, provider, truck, database, at, clock } = await setup();
    const response = await send(provider.key, [point("ALAT-01", at(-120), 0, { speedKph: 42.5, headingDeg: 90, accuracyM: 8 }), point("ALAT-01", at(-60), 0.5)]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ stored: 2, duplicates: 0, unknown: 0, unknownDeviceIds: [], refused: 0, refusedBy: NO_REFUSAL });
    expect(
      await database.query("select vehicle_id::int as v, trip_id, at, lat, speed_kph, heading_deg, accuracy_m, source_kind, source_id::int as s from vehicle_positions order by at"),
    ).toEqual([
      { v: truck, trip_id: null, at: new Date(at(-120)), lat: SEA.lat, speed_kph: 42.5, heading_deg: 90, accuracy_m: 8, source_kind: "DEVICE", s: provider.id },
      { v: truck, trip_id: null, at: new Date(at(-60)), lat: SEA.lat, speed_kph: null, heading_deg: null, accuracy_m: null, source_kind: "DEVICE", s: provider.id },
    ]);
    expect(await database.query("select vehicle_id::int as v, at, source_kind from vehicle_last_positions")).toEqual([{ v: truck, at: new Date(at(-60)), source_kind: "DEVICE" }]);
    expect(await database.query("select last_seen_at from gps_sources where id = $1", [provider.id])).toEqual([{ last_seen_at: clock.now() }]);
  });

  it("ignores a time the vehicle already has, also inside one batch", async () => {
    const { send, provider, at, database } = await setup();
    await send(provider.key, [point("ALAT-01", at(-60))]);
    const again = await send(provider.key, [point("ALAT-01", at(-60)), point("ALAT-01", at(-30)), point("ALAT-01", at(-30))]);
    expect(again.json()).toMatchObject({ stored: 1, duplicates: 2, refused: 0 });
    expect(await database.query("select count(*)::int as n from vehicle_positions")).toEqual([{ n: 2 }]);
  });

  it("counts device ids no tracker knows and remembers them per source until a tracker is attached", async () => {
    const { send, provider, call, at, clock, attach, vehicle, database } = await setup();
    const first = await send(provider.key, [point("BARU-7", at(-90)), point("BARU-7", at(-60)), point("BARU-8", at(-50)), point("ALAT-01", at(-40))]);
    expect(first.json()).toEqual({ stored: 1, duplicates: 0, unknown: 3, unknownDeviceIds: ["BARU-7", "BARU-8"], refused: 0, refusedBy: NO_REFUSAL });
    clock.advance(5 * MINUTE);
    await send(provider.key, [point("BARU-7", at(-10))]);
    const listed = await call("GET", `/api/gps/sources/${provider.id}/unknown-devices`, "lacak");
    expect(listed.json().items).toEqual([
      { deviceId: "BARU-7", firstSeenAt: "2026-11-20T03:00:00.000Z", lastSeenAt: "2026-11-20T03:05:00.000Z", lastPointAt: "2026-11-20T03:04:50.000Z", pointCount: 3 },
      { deviceId: "BARU-8", firstSeenAt: "2026-11-20T03:00:00.000Z", lastSeenAt: "2026-11-20T03:00:00.000Z", lastPointAt: "2026-11-20T02:59:10.000Z", pointCount: 1 },
    ]);
    expect(await database.query("select count(*)::int as n from vehicle_positions")).toEqual([{ n: 1 }]);
    await attach(await vehicle("ZZ 1107 GA"), provider.id, "BARU-7");
    expect((await call("GET", `/api/gps/sources/${provider.id}/unknown-devices`, "lacak")).json().items.map((row: { deviceId: string }) => row.deviceId)).toEqual(["BARU-8"]);
  });

  it("refuses coordinates out of range, times too far ahead or too old, and impossible jumps", async () => {
    const { send, provider, at, database } = await setup();
    const response = await send(provider.key, [
      { deviceId: "ALAT-01", at: at(-600), lat: 90.5, lon: SEA.lon },
      { deviceId: "ALAT-01", at: at(-590), lat: SEA.lat, lon: -180.5 },
      { deviceId: "ALAT-01", at: at(-580), lat: 0, lon: 0 },
      point("ALAT-01", at(-570), 0, { speedKph: -1 }),
      point("ALAT-01", at(-560), 0, { headingDeg: 361 }),
      point("ALAT-01", at(-550), 0, { accuracyM: -5 }),
      point("ALAT-01", at(6 * 60)),
      point("ALAT-01", at(4 * 60)),
      point("ALAT-01", new Date(Date.parse(at(0)) - 91 * DAY).toISOString()),
      point("ALAT-01", at(-300)),
      // 10 km one minute later: 600 km/h
      point("ALAT-01", at(-240), 10),
      // 3 km in 5 minutes after the point at -300: 36 km/h
      point("ALAT-01", at(0), 3),
    ]);
    expect(response.json()).toEqual({ stored: 3, duplicates: 0, unknown: 0, unknownDeviceIds: [], refused: 9, refusedBy: { range: 6, future: 1, tooOld: 1, jump: 1 } });
    expect((await database.query<{ at: Date }>("select at from vehicle_positions order by at")).map((row) => row.at.toISOString())).toEqual([at(-300), at(0), at(4 * 60)]);
  });

  it("checks a jump against the points stored before, on both sides of a late point", async () => {
    const { send, provider, at } = await setup();
    await send(provider.key, [point("ALAT-01", at(-600)), point("ALAT-01", at(-60), 5)]);
    // 50 km thirty seconds after the stored point at -600
    expect((await send(provider.key, [point("ALAT-01", at(-570), 50)])).json()).toMatchObject({ stored: 0, refusedBy: { jump: 1 } });
    // a small jitter is never a jump, even a second apart
    expect((await send(provider.key, [point("ALAT-01", at(-59), 5.3)])).json()).toMatchObject({ stored: 1, refused: 0 });
  });

  it("only moves the last position forward in time", async () => {
    const { send, provider, truck, at, database } = await setup();
    await send(provider.key, [point("ALAT-01", at(-60))]);
    await send(provider.key, [point("ALAT-01", at(-600), 1)]);
    expect(await database.query("select vehicle_id::int as v, at from vehicle_last_positions")).toEqual([{ v: truck, at: new Date(at(-60)) }]);
    await send(provider.key, [point("ALAT-01", at(-30), 0.2)]);
    expect(await database.query("select at from vehicle_last_positions")).toEqual([{ at: new Date(at(-30)) }]);
  });

  it("links a point to the trip the vehicle is on", async () => {
    const { send, provider, at, database, trip, vehicle, attach, companies } = await setup();
    const cases: [string, Parameters<typeof trip>[0] | null, boolean][] = [
      ["issued", { direction: "IN", partnerId: companies.supplier1, vehicleId: 0, status: "ISSUED" }, true],
      ["inside", { direction: "IN", partnerId: companies.supplier1, vehicleId: 0, status: "IN_PROCESS" }, true],
      ["out, left a day ago", { direction: "OUT", partnerId: companies.customer1, vehicleId: 0, status: "COMPLETED", exitedAt: "2026-11-19T03:00:00Z" }, true],
      ["out, left four days ago", { direction: "OUT", partnerId: companies.customer1, vehicleId: 0, status: "COMPLETED", exitedAt: "2026-11-16T03:00:00Z" }, false],
      ["in, completed", { direction: "IN", partnerId: companies.supplier1, vehicleId: 0, status: "COMPLETED" }, false],
      ["cancelled", { direction: "IN", partnerId: companies.supplier1, vehicleId: 0, status: "CANCELLED" }, false],
      ["issued, SPJ past its end", { direction: "IN", partnerId: companies.supplier1, vehicleId: 0, status: "ISSUED", spjValidUntil: "2026-11-20T02:00:00Z" }, false],
    ];
    let n = 0;
    for (const [name, seed, linked] of cases) {
      n++;
      const truckId = await vehicle(`ZZ 12${String(n).padStart(2, "0")} GB`);
      await attach(truckId, provider.id, `LINK-${n}`);
      const tripId = seed ? await trip({ ...seed, vehicleId: truckId }) : null;
      await send(provider.key, [point(`LINK-${n}`, at(-10))]);
      const [row] = await database.query<{ trip_id: number | null }>("select trip_id::int as trip_id from vehicle_positions where vehicle_id = $1", [truckId]);
      expect(row?.trip_id, name).toBe(linked ? tripId : null);
      const [last] = await database.query<{ trip_id: number | null }>("select trip_id::int as trip_id from vehicle_last_positions where vehicle_id = $1", [truckId]);
      expect(last?.trip_id, `${name}: last position`).toBe(linked ? tripId : null);
    }
    // a truck inside the plant wins over a later trip already issued
    const busy = await vehicle("ZZ 1299 GB");
    await attach(busy, provider.id, "LINK-BUSY");
    const inside = await trip({ direction: "IN", partnerId: companies.supplier1, vehicleId: busy, status: "CHECKED_IN" });
    await trip({ direction: "IN", partnerId: companies.supplier2, vehicleId: busy, status: "ISSUED" });
    await send(provider.key, [point("LINK-BUSY", at(-10))]);
    expect(await database.query("select trip_id::int as trip_id from vehicle_positions where vehicle_id = $1", [busy])).toEqual([{ trip_id: inside }]);
  });

  it("validates the body: at most 500 points, typed fields", async () => {
    const { send, provider, at } = await setup();
    const many = Array.from({ length: 501 }, (_, i) => point("ALAT-01", at(-1000 + i)));
    const tooMany = await send(provider.key, many);
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error.fields).toEqual([{ field: "points", message: "Paling banyak 500 titik per kiriman." }]);
    const wrong = await send(provider.key, [{ deviceId: "ALAT-01", at: "kemarin", lat: "1", lon: SEA.lon }]);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.fields.map((f: { field: string }) => f.field).sort()).toEqual(["points.0.at", "points.0.lat"]);
    expect((await send(provider.key, [])).statusCode).toBe(400);
  });

  it("refuses a body larger than the limit", async () => {
    const { app, provider } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/gps/positions",
      headers: { "x-tracker-key": provider.key, "content-type": "application/json" },
      payload: JSON.stringify({ points: [], padding: "x".repeat(300 * 1024) }),
    });
    expect(response.statusCode).toBe(413);
  });

  it("limits the requests per key in a minute", async () => {
    const { send, provider, at, clock, source, attach, vehicle } = await setup();
    for (let i = 0; i < 60; i++) expect((await send(provider.key, [point("ALAT-01", at(-100))])).statusCode).toBe(200);
    const limited = await send(provider.key, [point("ALAT-01", at(-100))]);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toEqual({ code: "RATE_LIMITED", message: "Terlalu banyak kiriman. Coba lagi sebentar lagi." });
    // another key is not held back
    const second = await source("Alat Tunggal Contoh", "DEVICE");
    await attach(await vehicle("ZZ 1108 GA"), second.id, "SATU");
    expect((await send(second.key, [point("SATU", at(-100))])).statusCode).toBe(200);
    clock.advance(MINUTE + 1);
    expect((await send(provider.key, [point("ALAT-01", at(-100))])).statusCode).toBe(200);
  });
});
