// Requests that run at the same moment on separate server connections. Only `npm run test:pg` runs this file:
// PGlite has one connection and runs one transaction at a time, so two requests there never overlap.
//
// Each test holds a lock from a third connection until both requests are waiting on the server, then lets go.
// That makes the overlap certain instead of depending on timing.
import { describe, expect, it } from "vitest";
import type { Database, SqlRunner } from "../src/db/client.js";
import { phase3App, seedCard, seedContract, seedDriver, seedVehicle } from "./helpers/fixtures.js";
import { walkInApp } from "./helpers/walk-in.js";
import { weighingApp } from "./helpers/weighing.js";

interface Answer {
  statusCode: number;
  json: () => { error?: { code: string } } & Record<string, unknown>;
}

/** Waits until `count` sessions of this database wait for a lock. */
async function waitForWaiters(database: Database, count: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const [row] = await database.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
    );
    if ((row?.n ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error(`expected ${count} sessions waiting for a lock, found ${row?.n ?? 0}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Starts the requests while `hold` keeps a lock, waits until each of them is blocked, then releases it. */
async function together(database: Database, hold: (tx: SqlRunner) => Promise<unknown>, requests: (() => Promise<Answer>)[]): Promise<Answer[]> {
  let running: Promise<Answer[]> | undefined;
  await database.transaction(async (tx) => {
    await hold(tx);
    running = Promise.all(requests.map((request) => request()));
    await waitForWaiters(database, requests.length);
  });
  if (!running) throw new Error("the requests did not start");
  return running;
}

const outcome = (answer: Answer) => (answer.statusCode === 200 || answer.statusCode === 201 ? "OK" : `${answer.statusCode} ${answer.json().error?.code}`);

async function gateSetup() {
  const context = await phase3App();
  const { database, companies, products, call } = context;
  const purchase = await seedContract(database, { no: "PC-901/CONTOH", partnerId: companies.supplier1, productId: products.cpo, qty: null });
  const issued = async (vehicle: number, driver: number) => {
    const response = await call("POST", "/api/registrations", "logistics", {
      direction: "IN", submit: true, plannedDate: "2026-11-20", allocations: [{ contractId: purchase }],
      trips: [{ vehicle: { id: vehicle }, driver: { id: driver } }],
    });
    if (response.statusCode !== 201) throw new Error(response.body);
    let registration = response.json().registration;
    if (registration.status === "SUBMITTED") registration = (await call("POST", `/api/registrations/${registration.id}/approve`, "logistics", {})).json().registration;
    return registration.trips[0].spj.barcodeToken as string;
  };
  const checkIn = (token: string, cardUid: string) => () => call("POST", "/api/gate/check-in", "pos", { token, cardUid });
  return { ...context, issued, checkIn };
}

describe("two check-ins at the same moment", () => {
  it("with the same card: one checks in, the other is refused CARD_IN_USE", async () => {
    const { database, issued, checkIn } = await gateSetup();
    const one = await issued(await seedVehicle(database, { plate: "BK 9101 CC" }), await seedDriver(database, { name: "Supir Balap Satu", licence: "SIMRACE001" }));
    const two = await issued(await seedVehicle(database, { plate: "BK 9102 CC" }), await seedDriver(database, { name: "Supir Balap Dua", licence: "SIMRACE002" }));
    await seedCard(database, "AB0000009001", "K-91");

    // both lock their own trip, then wait for the card row the third connection holds
    const answers = await together(database, (tx) => tx.query("select id from rfid_cards where uid = 'AB0000009001' for update"), [
      checkIn(one, "AB0000009001"),
      checkIn(two, "AB0000009001"),
    ]);
    expect(answers.map(outcome).sort()).toEqual(["409 CARD_IN_USE", "OK"]);
    expect(await database.query("select count(*)::int as n from card_assignments")).toEqual([{ n: 1 }]);
    expect(await database.query("select count(*)::int as n from trips where status = 'CHECKED_IN'")).toEqual([{ n: 1 }]);
  });

  it("of the same vehicle with two cards: the unique index stops the second, answered VEHICLE_INSIDE", async () => {
    const { database, issued, checkIn } = await gateSetup();
    const vehicle = await seedVehicle(database, { plate: "BK 9103 CC" });
    const one = await issued(vehicle, await seedDriver(database, { name: "Supir Balap Tiga", licence: "SIMRACE003" }));
    const two = await issued(vehicle, await seedDriver(database, { name: "Supir Balap Empat", licence: "SIMRACE004" }));
    await seedCard(database, "AB0000009002", "K-92");
    await seedCard(database, "AB0000009003", "K-93");

    // Both pass the "vehicle inside elsewhere" check, then wait at the trip number counter. The first commits;
    // the second then breaks trips_vehicle_inside_key, a unique violation raised by the server.
    const answers = await together(database, (tx) => tx.query("lock table document_counters in exclusive mode"), [
      checkIn(one, "AB0000009002"),
      checkIn(two, "AB0000009003"),
    ]);
    expect(answers.map(outcome).sort()).toEqual(["409 VEHICLE_INSIDE", "OK"]);
    expect(await database.query("select count(*)::int as n from trips where status = 'CHECKED_IN'")).toEqual([{ n: 1 }]);
    expect(await database.query("select status from rfid_cards where uid in ('AB0000009002', 'AB0000009003') order by uid")).toEqual(
      expect.arrayContaining([{ status: "IN_USE" }, { status: "AVAILABLE" }]),
    );
  });
});

describe("two walk-ins at the same moment", () => {
  it("with the same scan: one registers and checks in, the other is refused SCAN_ALREADY_USED and leaves nothing", async () => {
    const { database, scanOk, walkIn, vehicles, drivers } = await walkInApp();
    const proposal = await scanOk("IN");
    const [truck] = proposal.registration.trips;
    const body = (cardUid: string, vehicle: number, driver: number) => ({
      scanFileId: proposal.scan.fileId,
      cardUid,
      registration: { ...proposal.registration, trips: [{ ...truck, vehicle: { id: vehicle }, driver: { id: driver } }] },
    });

    // two trucks, two cards, one paper: both wait for the row of the scan the third connection holds
    const answers = await together(database, (tx) => tx.query("select id from files where id = $1 for update", [proposal.scan.fileId]), [
      () => walkIn(body("AB0000000001", vehicles.letter, drivers.letter)),
      () => walkIn(body("AB0000000002", vehicles.other, drivers.other)),
    ]);
    expect(answers.map(outcome).sort()).toEqual(["409 SCAN_ALREADY_USED", "OK"]);
    expect(await database.query("select count(*)::int as n from registrations")).toEqual([{ n: 1 }]);
    expect(await database.query("select count(*)::int as n from trip_files")).toEqual([{ n: 1 }]);
    expect(await database.query("select count(*)::int as n from rfid_cards where status = 'IN_USE'")).toEqual([{ n: 1 }]);
  });
});

describe("two weighings at the same moment", () => {
  it("with different request ids for the same truck and stage: exactly one weighing is stored", async () => {
    const { database, weigh, wbIn, incoming, forceReady } = await weighingApp();
    const truck = await incoming({ plate: "BK 9104 AA" });
    await forceReady(truck.tripId, "WEIGH_1");
    const body = { cardUid: truck.cardUid, weightKg: 30_010, plateRead: "BK 9104 AA" };

    const answers = await together(database, (tx) => tx.query("select id from trips where id = $1 for update", [truck.tripId]), [
      () => weigh(wbIn.key, { ...body, requestId: "race-weigh-0001" }),
      () => weigh(wbIn.key, { ...body, requestId: "race-weigh-0002" }),
    ]);
    expect(answers.map(outcome).sort()).toEqual(["409 NOT_READY", "OK"]);
    expect(await database.query("select stage, weight_kg from weighings where trip_id = $1", [truck.tripId])).toEqual([{ stage: 1, weight_kg: 30_010 }]);
  });

  it("with the same request id: both get the answer of the one that ran, and one weighing is stored", async () => {
    const { database, weigh, wbIn, incoming, forceReady } = await weighingApp();
    const truck = await incoming({ plate: "BK 9105 AA" });
    await forceReady(truck.tripId, "WEIGH_1");
    const body = { cardUid: truck.cardUid, weightKg: 30_020, plateRead: "BK 9105 AA", requestId: "race-weigh-0003" };

    const answers = await together(database, (tx) => tx.query("select id from trips where id = $1 for update", [truck.tripId]), [
      () => weigh(wbIn.key, body),
      () => weigh(wbIn.key, body),
    ]);
    expect(answers.map(outcome)).toEqual(["OK", "OK"]);
    expect(answers[0]?.json()).toEqual(answers[1]?.json());
    expect(await database.query("select count(*)::int as n from weighings where trip_id = $1", [truck.tripId])).toEqual([{ n: 1 }]);
  });
});
