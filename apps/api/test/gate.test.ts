import { describe, expect, it } from "vitest";
import { uniqueViolation } from "../src/gate/routes.js";
import { freshDatabase } from "./helpers/app.js";
import { phase3App, seedCard, seedContract, seedDriver, seedVehicle } from "./helpers/fixtures.js";

const DAY = 86_400_000;

async function setup() {
  const context = await phase3App();
  const { database, companies, products, call } = context;
  const purchase = await seedContract(database, { no: "PC-601/CONTOH", partnerId: companies.supplier1, productId: products.cpo, qty: null });
  const vehicles = {
    a: await seedVehicle(database, { plate: "BK 4001 DD" }),
    b: await seedVehicle(database, { plate: "BK 4002 DD" }),
    papers: await seedVehicle(database, { plate: "BK 4003 DD", stnk: "2026-11-01" }),
  };
  const drivers = {
    a: await seedDriver(database, { name: "Supir Pos Satu", licence: "SIMPOS0001" }),
    b: await seedDriver(database, { name: "Supir Pos Dua", licence: "SIMPOS0002" }),
    warning: await seedDriver(database, { name: "Supir Pos Tiga", licence: "SIMPOS0003", status: "WARNING" }),
  };
  const cards = {
    one: await seedCard(database, "AB0000000001", "K-01"),
    two: await seedCard(database, "AB0000000002", "K-02"),
    three: await seedCard(database, "AB0000000003", "K-03"),
    lost: await seedCard(database, "AB0000000009", "K-09", "LOST"),
  };
  /** An approved incoming truck (or one waiting for review when it has findings); answers trip id and token. */
  const issued = async (vehicle: number, driver: number) => {
    const response = await call("POST", "/api/registrations", "logistics", {
      direction: "IN", submit: true, plannedDate: "2026-11-20", allocations: [{ contractId: purchase }],
      trips: [{ vehicle: { id: vehicle }, driver: { id: driver } }],
    });
    if (response.statusCode !== 201) throw new Error(response.body);
    let registration = response.json().registration;
    if (registration.status === "SUBMITTED") registration = (await call("POST", `/api/registrations/${registration.id}/approve`, "logistics", {})).json().registration;
    const trip = registration.trips[0];
    return { tripId: trip.id as number, token: trip.spj.barcodeToken as string, registrationId: registration.id as number };
  };
  const scan = async (token: string, as = "pos") => call("GET", `/api/gate/spj/${encodeURIComponent(token)}`, as);
  const checkIn = async (token: string, cardUid: string, as = "pos") => call("POST", "/api/gate/check-in", as, { token, cardUid });
  const codeOf = async (response: { json: () => { error?: { code: string } } }) => response.json().error?.code;
  return { ...context, vehicles, drivers, cards, issued, scan, checkIn, codeOf };
}

describe("GET /api/gate/spj/:token", () => {
  it("finds the truck by a token typed loosely and lists nothing to check for a clean truck", async () => {
    const { issued, scan, vehicles, drivers } = await setup();
    const { tripId, token } = await issued(vehicles.a, drivers.a);
    // lower case, a dash, and the letters a person confuses with 1 and 0
    const typed = `${token.slice(0, 6)}-${token.slice(6)}`.toLowerCase().replaceAll("1", "l").replaceAll("0", "o");
    const response = await scan(typed);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      trip: expect.objectContaining({ id: tripId, status: "ISSUED", direction: "IN", flowCode: "IN_CPO", driver: expect.objectContaining({ registryStatus: "NORMAL" }) }),
      checks: [],
    });
  });

  it("answers 404 SPJ_NOT_FOUND for an unknown token and is for desk staff only", async () => {
    const { scan, issued, vehicles, drivers } = await setup();
    const unknown = await scan("ZZZZZZZZZZZZ");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("SPJ_NOT_FOUND");
    const { token } = await issued(vehicles.a, drivers.a);
    expect((await scan(token, "pks1")).statusCode).toBe(403);
    expect((await scan(token, "qc")).statusCode).toBe(403);
  });

  it("lists what the officer has to look at", async () => {
    const { issued, scan, checkIn, vehicles, drivers, database, call, clock } = await setup();
    const warned = await issued(vehicles.papers, drivers.warning);
    const levels = async (token: string) => (await scan(token)).json().checks.map((check: { code: string; level: string }) => `${check.level} ${check.code}`).sort();
    expect(await levels(warned.token)).toEqual(["WARN DRIVER_WARNING", "WARN STNK_EXPIRED"]);

    // the registry status changed after the SPJ was issued; a local block came in too
    await database.query("update drivers set registry_status = 'BLACKLIST' where id = $1", [drivers.warning]);
    await database.query("insert into driver_blocks (driver_id, reason) values ($1, 'contoh')", [drivers.warning]);
    expect(await levels(warned.token)).toEqual(["BLOCK DRIVER_BLACKLISTED", "BLOCK DRIVER_BLOCKED", "WARN STNK_EXPIRED"]);

    // the same truck and driver on another trip, already inside
    const first = await issued(vehicles.a, drivers.a);
    const second = await issued(vehicles.a, drivers.a);
    expect((await checkIn(first.token, "AB0000000001")).statusCode).toBe(200);
    expect(await levels(first.token)).toEqual(["BLOCK ALREADY_CHECKED_IN"]);
    expect(await levels(second.token)).toEqual(["BLOCK DRIVER_INSIDE", "BLOCK VEHICLE_INSIDE"]);

    // a reissued SPJ: the old token is revoked
    const old = await issued(vehicles.b, drivers.b);
    const renewed = (await call("POST", `/api/trips/${old.tripId}/spj/reissue`, "pos", { reason: "rusak" })).json().trip;
    expect(await levels(old.token)).toEqual(["BLOCK SPJ_REVOKED"]);
    expect((await scan(old.token)).json().trip.spj.barcodeToken).toBe(renewed.spj.barcodeToken);

    clock.advance(8 * DAY);
    const expired = await scan(renewed.spj.barcodeToken);
    expect(expired.json().trip.status).toBe("EXPIRED");
    expect(expired.json().checks.map((check: { code: string }) => check.code)).toEqual(["SPJ_EXPIRED"]);
  });
});

describe("POST /api/gate/check-in", () => {
  it("binds the card, numbers the trip per day, and copies the steps of the flow", async () => {
    const { issued, checkIn, vehicles, drivers, database, ids, cards, clock } = await setup();
    const { tripId, token } = await issued(vehicles.a, drivers.a);
    clock.advance(60_000);
    const response = await checkIn(token.toLowerCase(), "ab:00:00:00:00:01");
    expect(response.statusCode).toBe(200);
    expect(response.json().trip).toMatchObject({
      id: tripId,
      status: "CHECKED_IN",
      tripNo: "20261120-0001",
      checkedInAt: "2026-11-20T03:01:00.000Z",
      currentStep: "SEAL_CHECK",
      card: { uid: "AB0000000001", label: "K-01" },
    });
    expect(await database.query("select status from rfid_cards where id = $1", [cards.one])).toEqual([{ status: "IN_USE" }]);
    expect(await database.query("select card_id::int as card, assigned_by::int as by, released_at from card_assignments where trip_id = $1", [tripId])).toEqual([
      { card: cards.one, by: ids.pos, released_at: null },
    ]);
    const steps = await database.query<{ step_code: string; status: string; ready_at: Date | null; finished_at: Date | null }>(
      "select step_code, status, ready_at, finished_at from trip_steps where trip_id = $1 order by seq",
      [tripId],
    );
    expect(steps.map((step) => `${step.step_code}:${step.status}`)).toEqual([
      "CHECK_IN:DONE", "SEAL_CHECK:READY", "WEIGH_1:PENDING", "QC:PENDING", "UNLOADING:PENDING", "TANK_CHECK:PENDING", "RESEAL:PENDING", "WEIGH_2:PENDING", "CHECK_OUT:PENDING",
    ]);
    expect(steps[0]?.finished_at).toEqual(new Date("2026-11-20T03:01:00Z"));
    expect(steps[1]?.ready_at).toEqual(new Date("2026-11-20T03:01:00Z"));

    const next = await issued(vehicles.b, drivers.b);
    expect((await checkIn(next.token, "AB0000000002")).json().trip.tripNo).toBe("20261120-0002");
  });

  it("answers each refusal with its code and changes nothing", async () => {
    const { issued, checkIn, codeOf, vehicles, drivers, database, call, clock } = await setup();
    const notFound = await checkIn("ZZZZZZZZZZZZ", "AB0000000001");
    expect(notFound.statusCode).toBe(404);
    expect(await codeOf(notFound)).toBe("SPJ_NOT_FOUND");
    expect((await checkIn("ZZZZZZZZZZZZ", "not-hex")).statusCode).toBe(400);

    const a = await issued(vehicles.a, drivers.a);
    const unknownCard = await checkIn(a.token, "FFFFFFFF");
    expect(unknownCard.statusCode).toBe(409);
    expect(await codeOf(unknownCard)).toBe("CARD_UNKNOWN");
    expect(await codeOf(await checkIn(a.token, "AB0000000009"))).toBe("CARD_NOT_AVAILABLE");
    expect((await checkIn(a.token, "AB0000000001")).statusCode).toBe(200);
    expect(await codeOf(await checkIn(a.token, "AB0000000002"))).toBe("ALREADY_CHECKED_IN");

    const sameTruck = await issued(vehicles.a, drivers.b);
    expect(await codeOf(await checkIn(sameTruck.token, "AB0000000001"))).toBe("CARD_IN_USE");
    expect(await codeOf(await checkIn(sameTruck.token, "AB0000000002"))).toBe("VEHICLE_INSIDE");
    const sameDriver = await issued(vehicles.b, drivers.a);
    expect(await codeOf(await checkIn(sameDriver.token, "AB0000000002"))).toBe("DRIVER_INSIDE");

    const blacklisted = await issued(vehicles.papers, drivers.warning);
    await database.query("update drivers set registry_status = 'BLACKLIST' where id = $1", [drivers.warning]);
    expect(await codeOf(await checkIn(blacklisted.token, "AB0000000002"))).toBe("DRIVER_BLACKLISTED");
    await database.query("update drivers set registry_status = 'NORMAL' where id = $1", [drivers.warning]);
    await database.query("insert into driver_blocks (driver_id, reason) values ($1, 'contoh')", [drivers.warning]);
    expect(await codeOf(await checkIn(blacklisted.token, "AB0000000002"))).toBe("DRIVER_BLOCKED");

    const reissued = (await call("POST", `/api/trips/${sameTruck.tripId}/spj/reissue`, "pos", { reason: "rusak" })).json().trip.spj.barcodeToken;
    expect(await codeOf(await checkIn(sameTruck.token, "AB0000000002"))).toBe("SPJ_REVOKED");
    clock.advance(8 * DAY);
    expect(await codeOf(await checkIn(reissued, "AB0000000002"))).toBe("SPJ_EXPIRED");

    expect(await database.query("select count(*)::int as n from card_assignments")).toEqual([{ n: 1 }]);
    expect(await database.query("select uid from rfid_cards where status = 'IN_USE'")).toEqual([{ uid: "AB0000000001" }]);
  });

  it("lets only one of two simultaneous check-ins of the same card, the same truck or the same SPJ succeed", async () => {
    const { issued, checkIn, vehicles, drivers, database } = await setup();
    const statuses = async (calls: Promise<{ statusCode: number; json: () => { error?: { code: string } } }>[]) => {
      const responses = await Promise.all(calls);
      return responses.map((response) => (response.statusCode === 200 ? "OK" : response.json().error?.code)).sort();
    };
    const one = await issued(vehicles.a, drivers.a);
    const two = await issued(vehicles.b, drivers.b);
    expect(await statuses([checkIn(one.token, "AB0000000001"), checkIn(two.token, "AB0000000001")])).toEqual(["CARD_IN_USE", "OK"]);

    const truck1 = await issued(vehicles.papers, drivers.warning);
    const truck2 = await issued(vehicles.papers, await seedDriver(database, { name: "Supir Pos Empat", licence: "SIMPOS0004" }));
    expect(await statuses([checkIn(truck1.token, "AB0000000002"), checkIn(truck2.token, "AB0000000003")])).toEqual(["OK", "VEHICLE_INSIDE"]);
    expect(await database.query("select count(*)::int as n from trips where status = 'CHECKED_IN'")).toEqual([{ n: 2 }]);
  });
});

describe("unique violations at check-in", () => {
  it("are read back to the refusal codes from the database error", async () => {
    const database = await freshDatabase();
    await database.script(`
      insert into partners (name) values ('PT Uji');
      insert into users (kind, username, full_name, password_hash) values ('INTERNAL', 'u', 'U', 'x');
      insert into vehicle_types (code, name) values ('UJI', 'Uji') on conflict do nothing;
      insert into vehicles (plate_no, plate_display, vehicle_type_code) values ('BK1', 'BK 1', 'UJI');
      insert into drivers (full_name, licence_no) values ('Uji', 'SIM123456'), ('Uji Dua', 'SIM654321');
      insert into registrations (site_id, reg_no, direction, flow_code, partner_id, created_via, created_by)
        select s.id, 'R1', 'IN', 'IN_CPO', p.id, 'OPERATOR', u.id from sites s, partners p, users u;
      insert into trips (site_id, registration_id, seq, status, vehicle_id, driver_id)
        select r.site_id, r.id, 1, 'CHECKED_IN', v.id, d.id from registrations r, vehicles v, drivers d where d.licence_no = 'SIM123456';
    `);
    const error = await database.db
      .transaction(async (tx) => {
        await tx.execute(
          "insert into trips (site_id, registration_id, seq, status, vehicle_id, driver_id) select site_id, id, 2, 'CHECKED_IN', (select id from vehicles), (select id from drivers where licence_no = 'SIM654321') from registrations",
        );
      })
      .catch((caught: unknown) => caught);
    expect(uniqueViolation(error)).toBe("VEHICLE_INSIDE");
    expect(uniqueViolation(new Error("other"))).toBeNull();
  });
});

describe("POST /api/gate/replace-card", () => {
  it("releases the old card as replaced or lost and binds the new one", async () => {
    const { issued, checkIn, call, vehicles, drivers, database, cards } = await setup();
    const { tripId, token } = await issued(vehicles.a, drivers.a);
    const early = await call("POST", "/api/gate/replace-card", "pos", { tripId, cardUid: "AB0000000002", reason: "REPLACED" });
    expect(early.json().error.code).toBe("INVALID_STATE");
    await checkIn(token, "AB0000000001");

    const replaced = await call("POST", "/api/gate/replace-card", "pos", { tripId, cardUid: "ab0000000002", reason: "REPLACED" });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().trip).toMatchObject({ status: "CHECKED_IN", card: { uid: "AB0000000002", label: "K-02" } });
    expect(await database.query("select status from rfid_cards where id = $1", [cards.one])).toEqual([{ status: "RETIRED" }]);

    expect((await call("POST", "/api/gate/replace-card", "pos", { tripId, cardUid: "AB0000000002", reason: "LOST" })).json().error.code).toBe("CARD_IN_USE");
    const lost = await call("POST", "/api/gate/replace-card", "pos", { tripId, cardUid: "AB0000000003", reason: "LOST" });
    expect(lost.json().trip.card.uid).toBe("AB0000000003");
    expect(await database.query("select status from rfid_cards where id = $1", [cards.two])).toEqual([{ status: "LOST" }]);
    expect(await database.query("select release_reason from card_assignments where trip_id = $1 order by id", [tripId])).toEqual([
      { release_reason: "REPLACED" }, { release_reason: "LOST" }, { release_reason: null },
    ]);
    expect((await call("POST", "/api/gate/replace-card", "pos", { tripId, cardUid: "AB0000000001", reason: "BROKEN" })).statusCode).toBe(400);
    expect((await call("POST", "/api/gate/replace-card", "pks1", { tripId, cardUid: "AB0000000001", reason: "LOST" })).statusCode).toBe(403);
  });
});
