// The two journeys phase 3 has to carry from registration to check-in, through the HTTP routes only.
import { describe, expect, it } from "vitest";
import { DESTINATION, phase3App, seedCard, seedContract, seedDestination, seedDriver, seedVehicle, sendShipmentRequest, siteCode } from "./helpers/fixtures.js";

describe("phase 3 scenarios", () => {
  it("(a) one incoming truck with two purchase contracts, from the supplier's registration to check-in", async () => {
    // every account holds exactly what this run needs
    const { database, call, companies, products, clock } = await phase3App({}, {
      pks1: { registrations: "CREATE" },
      pos: { gate: "CREATE" },
      logistics: { rfid_cards: "VIEW" },
    });
    const site = await siteCode(database);
    const first = await seedContract(database, { no: "PC-901/CONTOH", partnerId: companies.supplier1, productId: products.cpo, qty: 200_000 });
    const second = await seedContract(database, { no: "PC-902/CONTOH", partnerId: companies.supplier1, productId: products.cpo, qty: 200_000 });
    // INL sent the supplier a request on both contracts (0017)
    for (const contractId of [first, second]) await sendShipmentRequest(database, contractId);
    const vehicle = await seedVehicle(database, { plate: "BK 9001 EE", ownerId: companies.transporter1 });
    const driver = await seedDriver(database, { name: "Supir Skenario A", licence: "SIMSKA0001" });
    await seedCard(database, "CA0000000001", "K-A1");

    // the supplier registers its truck carrying the letters of both contracts
    const created = await call("POST", "/api/registrations", "pks1", {
      direction: "IN",
      submit: true,
      transporterId: companies.transporter1,
      plannedDate: "2026-11-20",
      allocations: [{ contractId: first }, { contractId: second }],
      trips: [
        {
          vehicle: { id: vehicle },
          driver: { id: driver },
          letters: [
            { allocationSeq: 1, handoverNo: "PNY-A1", spbNo: "SPB-A1", spbDate: "2026-11-19", originGrossKg: 30_000, originTareKg: 10_000, originNetKg: 20_000, quality: { FFA: 3.2 } },
            { allocationSeq: 2, handoverNo: "PNY-A2", spbNo: "SPB-A2", spbDate: "2026-11-19", originGrossKg: 21_000, originTareKg: 10_000, originNetKg: 11_000, quality: { FFA: 3.4 } },
          ],
        },
      ],
    });
    expect(created.statusCode).toBe(201);
    const registration = created.json().registration;
    expect(registration).toMatchObject({ status: "APPROVED", findings: [], createdVia: "PORTAL", flowCode: "IN_CPO", qtyTotal: 31000 });
    const trip = registration.trips[0];
    expect(trip).toMatchObject({ status: "ISSUED", docTareKg: 10000, docNetKg: 31000, docGrossKg: 41000 });
    expect(trip.spj.spjNo).toBe(`SPJ/${site}/202611/00001`);

    // the supplier prints the SPJ
    const print = (await call("GET", `/api/trips/${trip.id}/spj`, "pks1")).json().spj;
    expect(print.lines.map((line: { contractNo: string; qtyPlanned: number }) => [line.contractNo, line.qtyPlanned])).toEqual([
      ["PC-901/CONTOH", 20000],
      ["PC-902/CONTOH", 11000],
    ]);
    expect((await call("POST", `/api/trips/${trip.id}/spj/printed`, "pks1")).json()).toEqual({ printCount: 1 });

    // at the gate an hour later: scan, nothing to look at, tap a card
    clock.advance(60 * 60_000);
    const scanned = (await call("GET", `/api/gate/spj/${trip.spj.barcodeToken}`, "pos")).json();
    expect(scanned).toMatchObject({ trip: { id: trip.id, status: "ISSUED" }, checks: [] });
    const checkedIn = await call("POST", "/api/gate/check-in", "pos", { token: trip.spj.barcodeToken, cardUid: "ca:00:00:00:00:01" });
    expect(checkedIn.statusCode).toBe(200);
    expect(checkedIn.json().trip).toMatchObject({ status: "CHECKED_IN", tripNo: "20261120-0001", currentStep: "SEAL_CHECK", card: { uid: "CA0000000001", label: "K-A1" }, checkedInAt: "2026-11-20T04:00:00.000Z" });

    const steps = await database.query<{ step_code: string; status: string }>("select step_code, status from trip_steps where trip_id = $1 order by seq", [trip.id]);
    expect(steps[0]).toEqual({ step_code: "CHECK_IN", status: "DONE" });
    expect(steps[1]).toEqual({ step_code: "SEAL_CHECK", status: "READY" });
    expect(steps.slice(2).every((step) => step.status === "PENDING")).toBe(true);
    expect((await call("GET", "/api/trips?status=CHECKED_IN", "pos")).json().items.map((item: { id: number }) => item.id)).toEqual([trip.id]);
    expect((await call("GET", "/api/rfid-cards?status=IN_USE", "logistics")).json().items[0].trip).toEqual({ id: trip.id, tripNo: "20261120-0001", plateNo: "BK9001EE" });
  });

  it("(b) one DO with four trucks, from the logistics admin to four check-ins", async () => {
    // every account holds exactly what this run needs
    const { database, call, companies, products } = await phase3App({}, {
      logistics: { delivery_orders: "EDIT" },
      angkut1: { delivery_orders: "EDIT", registrations: "CREATE" },
      pos: { gate: "CREATE" },
    });
    const sale = await seedContract(database, { no: "SC-901/CONTOH", direction: "OUT", partnerId: companies.customer1, productId: products.olein, qty: 500_000 });
    const place = await seedDestination(database, "Gudang Skenario B", companies.customer1);
    const vehicles: number[] = [];
    const drivers: number[] = [];
    for (const n of [1, 2, 3, 4]) {
      vehicles.push(await seedVehicle(database, { plate: `BK 910${n} FF`, ownerId: companies.transporter1, capacityKg: 30_000 }));
      drivers.push(await seedDriver(database, { name: `Supir Skenario B${n}`, licence: `SIMSKB000${n}` }));
      await seedCard(database, `CB000000000${n}`, `K-B${n}`);
    }

    // the logistics admin writes and sends the DO; the transporter accepts it with four trucks
    const order = (
      await call("POST", "/api/delivery-orders", "logistics", {
        doDate: "2026-11-20", contractId: sale, qty: 100_002, ...DESTINATION, deliveryFrom: "2026-11-20", deliveryUntil: "2026-11-27", transportTerms: "FRANCO",
      })
    ).json().deliveryOrder;
    expect(order).toMatchObject({ status: "DRAFT", partner: { id: companies.customer1 }, contract: { contractNo: "SC-901/CONTOH" } });
    expect((await call("POST", `/api/delivery-orders/${order.id}/send`, "logistics", { transporterId: companies.transporter1 })).json().deliveryOrder.status).toBe("SENT");
    expect((await call("GET", "/api/delivery-orders", "angkut1")).json().items.map((item: { id: number }) => item.id)).toEqual([order.id]);
    expect((await call("POST", `/api/delivery-orders/${order.id}/accept`, "angkut1", { truckCount: 4 })).json().deliveryOrder).toMatchObject({ status: "ACCEPTED", truckCount: 4, truckCountBy: "TRANSPORTER" });

    // the transporter submits its list of four trucks
    const created = await call("POST", "/api/registrations", "angkut1", {
      direction: "OUT",
      submit: true,
      closeCargo: true,
      flexiBag: false,
      plannedDate: "2026-11-21",
      allocations: [{ deliveryOrderId: order.id }],
      trips: vehicles.map((vehicle, index) => ({ vehicle: { id: vehicle }, driver: { id: drivers[index] }, handoverNo: `PNY-B${index + 1}` })),
    });
    expect(created.statusCode).toBe(201);
    const registration = created.json().registration;
    expect(registration).toMatchObject({ status: "APPROVED", findings: [], truckCount: 4, qtyTotal: 100002 });
    const trips = registration.trips as { id: number; qtyPlanned: number; status: string; spj: { barcodeToken: string; spjNo: string } }[];
    expect(trips.map((trip) => trip.qtyPlanned)).toEqual([25000, 25000, 25000, 25002]);
    expect(trips.every((trip) => trip.status === "ISSUED")).toBe(true);
    expect(new Set(trips.map((trip) => trip.spj.barcodeToken)).size).toBe(4);
    expect((await call("GET", `/api/delivery-orders/${order.id}`, "angkut1")).json().deliveryOrder).toMatchObject({ qtyPlanned: 100002, qtyRemaining: 0, tripCount: 4 });

    // all four trucks check in at the gate
    for (const [index, trip] of trips.entries()) {
      const scan = (await call("GET", `/api/gate/spj/${trip.spj.barcodeToken}`, "pos")).json();
      expect(scan.checks).toEqual([]);
      const response = await call("POST", "/api/gate/check-in", "pos", { token: trip.spj.barcodeToken, cardUid: `CB000000000${index + 1}` });
      expect(response.statusCode).toBe(200);
      expect(response.json().trip).toMatchObject({ status: "CHECKED_IN", tripNo: `20261120-000${index + 1}`, currentStep: "WEIGH_1", card: { label: `K-B${index + 1}` } });
    }
    const detail = (await call("GET", `/api/delivery-orders/${order.id}`, "logistics")).json();
    expect(detail.trips.map((trip: { status: string }) => trip.status)).toEqual(["CHECKED_IN", "CHECKED_IN", "CHECKED_IN", "CHECKED_IN"]);
    expect(await database.query("select count(*)::int as n from trip_steps")).toEqual([{ n: 4 * 8 }]);
    // with trucks inside, the DO can no longer be cancelled
    expect((await call("POST", `/api/delivery-orders/${order.id}/cancel`, "logistics", { reason: "x" })).json().error.code).toBe("INVALID_STATE");
  });
});
