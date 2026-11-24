import { describe, expect, it } from "vitest";
import { newBarcodeToken, normaliseToken, TOKEN_ALPHABET } from "../src/trips/spj.js";
import { DESTINATION, phase3App, seedCard, seedContract, seedDestination, seedDriver, seedVehicle, siteCode } from "./helpers/fixtures.js";

const DAY = 86_400_000;

async function setup() {
  const context = await phase3App();
  const { database, companies, products, call } = context;
  const purchase = await seedContract(database, { no: "PC-501/CONTOH", partnerId: companies.supplier1, productId: products.cpo });
  const vehicle = await seedVehicle(database, { plate: "BK 3001 CC", ownerId: companies.transporter1 });
  const vehicle2 = await seedVehicle(database, { plate: "BK 3002 CC", ownerId: companies.transporter1, type: "BOX" });
  const driver = await seedDriver(database, { name: "Supir Surat Satu", licence: "SIMSPJ0001" });
  const driver2 = await seedDriver(database, { name: "Supir Surat Dua", licence: "SIMSPJ0002" });
  const incoming = async (as = "pks1", over: object = {}) => {
    const response = await call("POST", "/api/registrations", as, {
      direction: "IN",
      submit: true,
      plannedDate: "2026-11-21",
      transporterId: companies.transporter1,
      allocations: [{ contractId: purchase }],
      trips: [{ vehicle: { id: vehicle }, driver: { id: driver }, containerNo: "CONT-1", letters: [{ allocationSeq: 1, originNetKg: 25_000 }], ...over }],
    });
    if (response.statusCode !== 201) throw new Error(response.body);
    const registration = response.json().registration;
    return { registration, trip: registration.trips[0] as { id: number; spj: { id: number; spjNo: string; barcodeToken: string } } };
  };
  const sale = await seedContract(database, { no: "SC-501/CONTOH", direction: "OUT", partnerId: companies.customer1, productId: products.olein });
  const place = await seedDestination(database, "Gudang Tujuan Contoh");
  const outgoing = async () => {
    const order = (await call("POST", "/api/delivery-orders", "logistics", { doDate: "2026-11-20", contractId: sale, qty: 30_000, ...DESTINATION, deliveryFrom: "2026-11-20", transporterId: companies.transporter1 })).json().deliveryOrder;
    await call("POST", `/api/delivery-orders/${order.id}/send`, "logistics", {});
    await call("POST", `/api/delivery-orders/${order.id}/accept`, "angkut1", {});
    const response = await call("POST", "/api/registrations", "angkut1", {
      direction: "OUT", submit: true, closeCargo: true, flexiBag: true, plannedDate: "2026-11-22",
      allocations: [{ deliveryOrderId: order.id }],
      trips: [{ vehicle: { id: vehicle2 }, driver: { id: driver2 } }],
    });
    if (response.statusCode !== 201) throw new Error(response.body);
    return { order, registration: response.json().registration };
  };
  /** Puts a card on the trip the way check-in does, without the gate route. */
  const checkInByHand = async (tripId: number) => {
    const card = await seedCard(database, "ABCDEF01", "K-1", "IN_USE");
    await database.query("update trips set status = 'CHECKED_IN', checked_in_at = now(), current_step = 'SEAL_CHECK' where id = $1", [tripId]);
    await database.query("insert into card_assignments (card_id, trip_id, assigned_by) values ($1, $2, $3)", [card, tripId, context.ids.pos]);
    await database.query("insert into trip_steps (trip_id, step_code, seq, status) values ($1, 'CHECK_IN', 1, 'DONE'), ($1, 'SEAL_CHECK', 2, 'READY'), ($1, 'WEIGH_1', 3, 'PENDING')", [tripId]);
    return card;
  };
  return { ...context, incoming, outgoing, checkInByHand, site: await siteCode(database), place };
}

describe("barcode token", () => {
  it("is 12 symbols of the Crockford alphabet, different every time", () => {
    const tokens = Array.from({ length: 2000 }, () => newBarcodeToken());
    expect(tokens.every((token) => /^[0-9A-HJKMNP-TV-Z]{12}$/.test(token))).toBe(true);
    expect(new Set(tokens).size).toBe(tokens.length);
    // every symbol shows up: the generator is not stuck on part of the alphabet
    expect(new Set(tokens.join("")).size).toBe(TOKEN_ALPHABET.length);
  });

  it("is read back in upper case, without separators, with I and L as 1 and O as 0", () => {
    expect(normaliseToken(" abc-def ilo 9z ")).toBe("ABCDEF1109Z");
  });
});

describe("SPJ print data", () => {
  it("answers what the printed page shows, for the owner and for staff, and counts prints", async () => {
    const { incoming, outgoing, call, site, companies, place } = await setup();
    const { trip } = await incoming();
    const response = await call("GET", `/api/trips/${trip.id}/spj`, "pks1");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      spj: {
        // the second QR code: the driver's location-sharing page (gps-share.test.ts)
        shareUrl: expect.stringMatching(/^http:\/\/localhost:3000\/bagi-lokasi\/[A-Za-z0-9_-]{22}$/),
        spjNo: trip.spj.spjNo,
        barcodeToken: trip.spj.barcodeToken,
        issuedAt: "2026-11-20T03:00:00.000Z",
        validUntil: "2026-11-27T03:00:00.000Z",
        printCount: 0,
        site: { code: site, name: expect.any(String) },
        direction: "IN",
        driver: { fullName: "Supir Surat Satu", licenceNo: "SIMSPJ0001" },
        vehicle: { plateDisplay: "BK 3001 CC", vehicleType: "Truk tangki" },
        containerNo: "CONT-1",
        transporter: { id: companies.transporter1, name: "PT Angkut Satu" },
        lines: [{ contractNo: "PC-501/CONTOH", doNo: null, product: { id: expect.any(Number), name: "Minyak Contoh Mentah" }, qtyPlanned: 25000, uom: "kg", partner: { id: companies.supplier1, name: "PT Sawit Satu" }, destination: null }],
      },
    });
    expect((await call("GET", `/api/trips/${trip.id}/spj`, "pks2")).statusCode).toBe(404);
    expect((await call("GET", `/api/trips/${trip.id}/spj`, "pos")).statusCode).toBe(200);

    expect((await call("POST", `/api/trips/${trip.id}/spj/printed`, "pks1")).json()).toEqual({ printCount: 1 });
    expect((await call("POST", `/api/trips/${trip.id}/spj/printed`, "pos")).json()).toEqual({ printCount: 2 });
    expect((await call("POST", `/api/trips/${trip.id}/spj/printed`, "pks2")).statusCode).toBe(404);

    const { order, registration } = await outgoing();
    const out = (await call("GET", `/api/trips/${registration.trips[0].id}/spj`, "angkut1")).json().spj;
    expect(out).toMatchObject({ direction: "OUT", lines: [{ doNo: order.doNo, contractNo: "SC-501/CONTOH", qtyPlanned: 30000, partner: { id: companies.customer1 }, destination: { id: null, name: "Gudang Contoh", address: "Jl. Contoh 1", regency: "Kab. Contoh" } }] });
  });

  it("answers 404 for a trip without an active SPJ", async () => {
    const { call, incoming, database } = await setup();
    const { trip } = await incoming();
    await database.query("update spj_documents set revoked_at = now()");
    expect((await call("GET", `/api/trips/${trip.id}/spj`, "pks1")).statusCode).toBe(404);
  });
});

describe("SPJ reissue", () => {
  it("revokes the old SPJ with the reason and issues a new number and token", async () => {
    const { incoming, call, database, clock } = await setup();
    const { trip } = await incoming();
    clock.advance(DAY);
    expect((await call("POST", `/api/trips/${trip.id}/spj/reissue`, "pks1", { reason: "hilang" })).statusCode).toBe(403);
    expect((await call("POST", `/api/trips/${trip.id}/spj/reissue`, "pos", {})).statusCode).toBe(400);
    const response = await call("POST", `/api/trips/${trip.id}/spj/reissue`, "pos", { reason: "kertas hilang" });
    expect(response.statusCode).toBe(200);
    const spj = response.json().trip.spj;
    expect(spj.barcodeToken).not.toBe(trip.spj.barcodeToken);
    expect(spj.spjNo).not.toBe(trip.spj.spjNo);
    expect(spj).toMatchObject({ issuedAt: "2026-11-21T03:00:00.000Z", validUntil: "2026-11-28T03:00:00.000Z", printCount: 0 });
    expect(await database.query("select revoke_reason, revoked_at is not null as revoked from spj_documents where id = $1", [trip.spj.id])).toEqual([{ revoke_reason: "kertas hilang", revoked: true }]);
  });

  it("brings an expired trip back, and refuses a trip that has checked in", async () => {
    const { incoming, call, clock, checkInByHand } = await setup();
    const { trip } = await incoming();
    clock.advance(8 * DAY);
    expect((await call("GET", `/api/registrations/${(await call("GET", `/api/trips?q=${trip.spj.spjNo}`, "pos")).json().items[0]?.registrationId}`, "pks1")).json().registration.trips[0].status).toBe("EXPIRED");
    const renewed = await call("POST", `/api/trips/${trip.id}/spj/reissue`, "logistics", { reason: "lewat masa berlaku" });
    expect(renewed.json().trip).toMatchObject({ status: "ISSUED", spj: { validUntil: "2026-12-05T03:00:00.000Z" } });

    await checkInByHand(trip.id);
    const refused = await call("POST", `/api/trips/${trip.id}/spj/reissue`, "logistics", { reason: "x" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("INVALID_STATE");
  });
});

describe("GET /api/trips", () => {
  it("lists trips for staff with status, date and text filters, and expires SPJs past their validity", async () => {
    const { incoming, outgoing, call, clock, companies } = await setup();
    const { trip, registration } = await incoming();
    const { registration: outRegistration } = await outgoing();
    const list = async (query = "") => (await call("GET", `/api/trips${query}`, "pos")).json();

    const all = await list();
    expect(all.total).toBe(2);
    expect(all.items.find((item: { id: number }) => item.id === trip.id)).toMatchObject({
      registrationId: registration.id,
      direction: "IN",
      flowCode: "IN_CPO",
      partner: { id: companies.supplier1 },
      transporter: { id: companies.transporter1 },
      currentStep: null,
      status: "ISSUED",
      vehicle: { plateNo: "BK3001CC" },
    });
    expect((await list("?date=2026-11-21")).items.map((item: { id: number }) => item.id)).toEqual([trip.id]);
    expect((await list("?date=2026-11-22")).items.map((item: { id: number }) => item.id)).toEqual([outRegistration.trips[0].id]);
    expect((await list("?q=bk 3002")).total).toBe(1);
    expect((await list(`?q=${encodeURIComponent(trip.spj.spjNo)}`)).total).toBe(1);
    expect((await list("?status=CHECKED_IN")).total).toBe(0);
    expect((await list("?status=ISSUED,CHECKED_IN")).total).toBe(2);
    expect((await call("GET", "/api/trips?status=NONSENSE", "pos")).statusCode).toBe(400);
    expect((await call("GET", "/api/trips", "pks1")).statusCode).toBe(403);

    clock.advance(7 * DAY + 1000);
    expect((await list("?status=EXPIRED")).total).toBe(2);
  });
});

describe("POST /api/trips/:id/cancel", () => {
  it("lets the owner cancel before check-in, and staff after check-in, releasing the card", async () => {
    const { incoming, call, checkInByHand, database, ids } = await setup();
    const { trip } = await incoming();
    expect((await call("POST", `/api/trips/${trip.id}/cancel`, "pks2", { reason: "x" })).statusCode).toBe(404);
    expect((await call("POST", `/api/trips/${trip.id}/cancel`, "pks1", {})).statusCode).toBe(400);
    const own = await call("POST", `/api/trips/${trip.id}/cancel`, "pks1", { reason: "truk rusak" });
    expect(own.statusCode).toBe(200);
    expect(own.json().trip).toMatchObject({ status: "CANCELLED", spj: null, cancelReason: "truk rusak" });
    expect((await call("POST", `/api/trips/${trip.id}/cancel`, "pks1", { reason: "x" })).json().error.code).toBe("INVALID_STATE");

    const { trip: second } = await incoming();
    const card = await checkInByHand(second.id);
    expect((await call("POST", `/api/trips/${second.id}/cancel`, "pks1", { reason: "x" })).json().error.code).toBe("INVALID_STATE");
    const byStaff = await call("POST", `/api/trips/${second.id}/cancel`, "pos", { reason: "batal sebelum timbang" });
    expect(byStaff.statusCode).toBe(200);
    expect(byStaff.json().trip).toMatchObject({ status: "CANCELLED", card: null, currentStep: null });
    expect(await database.query("select status from rfid_cards where id = $1", [card])).toEqual([{ status: "AVAILABLE" }]);
    expect(await database.query("select release_reason, released_by::int as by from card_assignments where card_id = $1", [card])).toEqual([{ release_reason: "CANCELLED", by: ids.pos }]);
    expect(await database.query("select step_code, status from trip_steps where trip_id = $1 order by seq", [second.id])).toEqual([
      { step_code: "CHECK_IN", status: "DONE" },
      { step_code: "SEAL_CHECK", status: "SKIPPED" },
      { step_code: "WEIGH_1", status: "SKIPPED" },
    ]);

    const { trip: third } = await incoming();
    await database.query("update trips set status = 'IN_PROCESS' where id = $1", [third.id]);
    expect((await call("POST", `/api/trips/${third.id}/cancel`, "logistics", { reason: "x" })).json().error.code).toBe("INVALID_STATE");
  });
});
