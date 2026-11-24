// Sharing the driver's phone location through the link printed on the SPJ: the link is made when the SPJ is issued or
// reissued, the public routes answer only what the driver's page needs, and sharing closes with the trip.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueSpj } from "../src/trips/spj.js";
import { gpsApp, SEA } from "./helpers/gps.js";

const MINUTE = 60_000;
const NO_REFUSAL = { range: 0, future: 0, tooOld: 0, jump: 0 };
const SHARE_URL = /^http:\/\/localhost:3000\/bagi-lokasi\/([A-Za-z0-9_-]{22})$/;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

async function setup() {
  const context = await gpsApp();
  const { database, vehicle, trip, companies, ids, call } = context;
  /** An incoming trip of supplier1 issued through issueSpj, the way an approval does it; answers its id and token. */
  const issued = async (plate = "ZZ 2101 GA") => {
    const truck = await vehicle(plate, companies.transporter1);
    const tripId = await trip({ direction: "IN", partnerId: companies.supplier1, vehicleId: truck, status: "DRAFT", spjValidUntil: null });
    await database.query("update trips set status = 'READY' where id = $1", [tripId]);
    await database.db.transaction((tx) => issueSpj(tx, tripId, ids.logistik, context.clock.now()));
    return { tripId, truck, token: await tokenOf(tripId) };
  };
  /** The token of the share URL the printed SPJ carries. */
  const tokenOf = async (tripId: number) => {
    const response = await call("GET", `/api/trips/${tripId}/spj`, "logistik");
    expect(response.statusCode, response.body).toBe(200);
    const url = response.json().spj.shareUrl as string | null;
    return url === null ? null : (SHARE_URL.exec(url)?.[1] ?? "no match");
  };
  const share = (token: string) => call("GET", `/api/gps/share/${token}`, null);
  const post = (token: string, points: unknown[]) => call("POST", `/api/gps/share/${token}/positions`, null, { points });
  const phonePoint = (atIso: string, km = 0) => ({ at: atIso, lat: SEA.lat, lon: SEA.lon + km / 109.6, accuracyM: 12 });
  return { ...context, issued, tokenOf, share, post, phonePoint };
}

describe("share links", () => {
  it("are made when the SPJ is issued; the SPJ view carries the URL and only a hash is stored", async () => {
    const { issued, database } = await setup();
    const { tripId, token } = await issued();
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const rows = await database.query<{ token_hash: string; revoked_at: Date | null }>("select token_hash, revoked_at from trip_share_links where trip_id = $1", [tripId]);
    expect(rows).toEqual([{ token_hash: sha256(token as string), revoked_at: null }]);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("gives the same URL on every print", async () => {
    const { issued, tokenOf } = await setup();
    const { tripId, token } = await issued();
    expect(await tokenOf(tripId)).toBe(token);
  });

  it("are replaced when the SPJ is reissued: the old link stops working", async () => {
    const { issued, call, share, tokenOf } = await setup();
    const { tripId, token } = await issued();
    const reissued = await call("POST", `/api/trips/${tripId}/spj/reissue`, "logistik", { reason: "SPJ rusak" });
    expect(reissued.statusCode, reissued.body).toBe(200);
    const fresh = await tokenOf(tripId);
    expect(fresh).not.toBe(token);
    expect((await share(token as string)).statusCode).toBe(404);
    expect((await share(fresh as string)).statusCode).toBe(200);
  });

  it("are made for a trip issued before links existed, the first time its SPJ is printed", async () => {
    const { trip, vehicle, companies, tokenOf, database, share } = await setup();
    const tripId = await trip({ direction: "IN", partnerId: companies.supplier1, vehicleId: await vehicle("ZZ 2102 GA"), status: "ISSUED" });
    const token = await tokenOf(tripId);
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await database.query("select count(*)::int as n from trip_share_links where trip_id = $1", [tripId])).toEqual([{ n: 1 }]);
    expect((await share(token as string)).statusCode).toBe(200);
  });

  it("can be revoked and renewed by staff with gps EDIT", async () => {
    const { issued, call, share, tokenOf } = await setup();
    const { tripId, token } = await issued();
    for (const user of ["lihat", "pks1", "logistik"]) {
      expect((await call("POST", `/api/gps/trips/${tripId}/share-link/revoke`, user)).statusCode, user).toBe(403);
      expect((await call("POST", `/api/gps/trips/${tripId}/share-link/renew`, user)).statusCode, user).toBe(403);
    }
    const revoked = await call("POST", `/api/gps/trips/${tripId}/share-link/revoke`, "lacak");
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ shareUrl: null });
    expect((await share(token as string)).statusCode).toBe(404);
    // a revoked link is not made again by printing
    expect(await tokenOf(tripId)).toBeNull();
    expect((await call("POST", `/api/gps/trips/${tripId}/share-link/revoke`, "lacak")).statusCode).toBe(409);

    const renewed = await call("POST", `/api/gps/trips/${tripId}/share-link/renew`, "lacak");
    expect(renewed.statusCode).toBe(200);
    const fresh = SHARE_URL.exec(renewed.json().shareUrl)?.[1];
    expect(fresh).toBe(await tokenOf(tripId));
    expect((await share(fresh as string)).statusCode).toBe(200);
    expect((await call("POST", "/api/gps/trips/999999/share-link/renew", "lacak")).statusCode).toBe(404);
  });

  it("are not renewed for a trip whose sharing is closed", async () => {
    const { trip, vehicle, companies, call } = await setup();
    const tripId = await trip({ direction: "IN", partnerId: companies.supplier1, vehicleId: await vehicle("ZZ 2103 GA"), status: "COMPLETED" });
    const response = await call("POST", `/api/gps/trips/${tripId}/share-link/renew`, "lacak");
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toEqual({ code: "INVALID_STATE", message: "Perjalanan ini sudah selesai; lokasinya tidak bisa dibagikan lagi." });
  });
});

describe("GET /api/gps/share/:token", () => {
  it("answers only the plate and whether sharing is open, in plain words", async () => {
    const { issued, share } = await setup();
    const { token } = await issued();
    const response = await share(token as string);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ plateDisplay: "ZZ 2101 GA", open: true, until: "Sampai truk selesai dan keluar dari pabrik.", untilAt: null });
  });

  it("follows the trip: open until closed, outgoing until the customer window after exit", async () => {
    const { trip, vehicle, companies, share, tokenOf, database } = await setup();
    const cases: [string, Parameters<typeof trip>[0], object][] = [
      ["out, on its way to the plant", { direction: "OUT", partnerId: companies.customer1, vehicleId: 0, status: "ISSUED" },
        { open: true, until: "Sampai 3 hari setelah truk keluar dari pabrik.", untilAt: null }],
      ["out, left a day ago", { direction: "OUT", partnerId: companies.customer1, vehicleId: 0, status: "COMPLETED", exitedAt: "2026-11-19T03:00:00Z" },
        { open: true, until: "Sampai 22 November 2026 pukul 10.00 WIB.", untilAt: "2026-11-22T03:00:00.000Z" }],
      ["out, left four days ago", { direction: "OUT", partnerId: companies.customer1, vehicleId: 0, status: "COMPLETED", exitedAt: "2026-11-16T03:00:00Z" },
        { open: false, until: "Berbagi lokasi untuk perjalanan ini sudah ditutup.", untilAt: null }],
      ["in, inside the plant", { direction: "IN", partnerId: companies.supplier1, vehicleId: 0, status: "IN_PROCESS" },
        { open: true, until: "Sampai truk selesai dan keluar dari pabrik.", untilAt: null }],
      ["in, completed", { direction: "IN", partnerId: companies.supplier1, vehicleId: 0, status: "COMPLETED" },
        { open: false, until: "Berbagi lokasi untuk perjalanan ini sudah ditutup.", untilAt: null }],
      ["out, rejected", { direction: "OUT", partnerId: companies.customer1, vehicleId: 0, status: "REJECTED" },
        { open: false, until: "Berbagi lokasi untuk perjalanan ini sudah ditutup.", untilAt: null }],
      ["cancelled", { direction: "IN", partnerId: companies.supplier1, vehicleId: 0, status: "CANCELLED" },
        { open: false, until: "Berbagi lokasi untuk perjalanan ini sudah ditutup.", untilAt: null }],
      ["expired", { direction: "IN", partnerId: companies.supplier1, vehicleId: 0, status: "EXPIRED" },
        { open: false, until: "Berbagi lokasi untuk perjalanan ini sudah ditutup.", untilAt: null }],
      ["issued, SPJ past its end", { direction: "IN", partnerId: companies.supplier1, vehicleId: 0, status: "ISSUED", spjValidUntil: "2026-11-20T02:00:00Z" },
        { open: false, until: "Berbagi lokasi untuk perjalanan ini sudah ditutup.", untilAt: null }],
    ];
    let n = 0;
    for (const [name, seed, expected] of cases) {
      n++;
      const plate = `ZZ 22${String(n).padStart(2, "0")} GA`;
      const tripId = await trip({ ...seed, vehicleId: await vehicle(plate) });
      // a link as an earlier issue left it; printing a closed trip makes none, so it is written here
      await database.query("insert into trip_share_links (trip_id) values ($1)", [tripId]);
      const token = await tokenOf(tripId);
      const response = await share(token as string);
      expect(response.statusCode, name).toBe(200);
      expect(response.json(), name).toEqual({ plateDisplay: plate, ...expected });
    }
  });

  it("answers 404 for a token that does not exist", async () => {
    const { share } = await setup();
    for (const token of ["AAAAAAAAAAAAAAAAAAAAAA", "kurang", "x".repeat(90)]) {
      const response = await share(token);
      expect(response.statusCode, token).toBe(404);
      expect(response.json().error.code).toBe("NOT_FOUND");
    }
  });
});

describe("POST /api/gps/share/:token/positions", () => {
  it("stores the phone's points on the trip and its vehicle", async () => {
    const { issued, post, phonePoint, at, database } = await setup();
    const { tripId, truck, token } = await issued();
    const response = await post(token as string, [phonePoint(at(-30)), phonePoint(at(-15), 0.2), phonePoint(at(-15), 0.2)]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ stored: 2, duplicates: 1, refused: 0, refusedBy: NO_REFUSAL });
    expect(await database.query("select vehicle_id::int as v, trip_id::int as t, source_kind, source_id, accuracy_m from vehicle_positions order by at")).toEqual([
      { v: truck, t: tripId, source_kind: "PHONE", source_id: null, accuracy_m: 12 },
      { v: truck, t: tripId, source_kind: "PHONE", source_id: null, accuracy_m: 12 },
    ]);
    expect(await database.query("select trip_id::int as t, source_kind, at from vehicle_last_positions")).toEqual([{ t: tripId, source_kind: "PHONE", at: new Date(at(-15)) }]);
  });

  it("applies the same checks as the device intake", async () => {
    const { issued, post, phonePoint, at } = await setup();
    const { token } = await issued();
    const response = await post(token as string, [
      { at: at(-60), lat: 95, lon: SEA.lon },
      phonePoint(at(10 * 60)),
      phonePoint(at(-50)),
      phonePoint(at(-40), 20),
    ]);
    expect(response.json()).toEqual({ stored: 1, duplicates: 0, refused: 3, refusedBy: { range: 1, future: 1, tooOld: 0, jump: 1 } });
    const tooMany = await post(token as string, Array.from({ length: 61 }, (_, i) => phonePoint(at(-100 + i))));
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error.fields).toEqual([{ field: "points", message: "Paling banyak 60 titik per kiriman." }]);
  });

  it("refuses points once sharing is closed, and for a revoked link", async () => {
    const { issued, post, phonePoint, at, database, call } = await setup();
    const { tripId, token } = await issued();
    await database.query("update trips set status = 'CANCELLED', cancelled_at = now() where id = $1", [tripId]);
    const closed = await post(token as string, [phonePoint(at(-10))]);
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error).toEqual({ code: "SHARING_CLOSED", message: "Berbagi lokasi untuk perjalanan ini sudah ditutup." });

    const other = await issued("ZZ 2104 GA");
    await call("POST", `/api/gps/trips/${other.tripId}/share-link/revoke`, "lacak");
    expect((await post(other.token as string, [phonePoint(at(-10))])).statusCode).toBe(404);
    expect(await database.query("select count(*)::int as n from vehicle_positions")).toEqual([{ n: 0 }]);
  });

  it("limits the requests per link in a minute", async () => {
    const { issued, post, phonePoint, at, clock } = await setup();
    const first = await issued();
    const second = await issued("ZZ 2105 GA");
    for (let i = 0; i < 20; i++) expect((await post(first.token as string, [phonePoint(at(-5))])).statusCode).toBe(200);
    const limited = await post(first.token as string, [phonePoint(at(-5))]);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");
    expect((await post(second.token as string, [phonePoint(at(-5))])).statusCode).toBe(200);
    clock.advance(MINUTE + 1);
    expect((await post(first.token as string, [phonePoint(at(-5))])).statusCode).toBe(200);
  });
});
