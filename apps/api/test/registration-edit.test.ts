// A registration that was already sent may still change while its trucks have not checked in at the post (owner,
// 26 November 2026: "data yg dikirim transporter atau supplier, jika belum di scan barcode / di proses di INL, masih
// bisa di edit"). PUT /api/registrations/:id on a SUBMITTED or APPROVED registration, through amendRegistration.
import { describe, expect, it } from "vitest";
import { DESTINATION, phase3App, seedCard, seedContract, seedDriver, seedVehicle, sendShipmentRequest } from "./helpers/fixtures.js";
import { seedStaff } from "./helpers/users.js";

type Trip = { id: number; seq: number; status: string; qtyPlanned: number; vehicle: { id: number } | null; spj: { barcodeToken: string; spjNo: string } | null; edit: { allowed: boolean; reason: string | null } };
type Shown = { id: number; status: string; findings: { code: string }[]; trips: Trip[]; edit: { allowed: boolean; allocationsLocked: boolean; reason: string | null }; remark: string | null };

async function setup() {
  const context = await phase3App();
  const { database, companies, products, call } = context;
  await seedStaff(database, "peninjau", { registrations: "EDIT", gate: "EDIT" });
  await seedStaff(database, "pembuat", { registrations: "CREATE" });
  const purchase = await seedContract(database, { no: "PC-EDIT-01/CONTOH", partnerId: companies.supplier1, productId: products.cpo, qty: 100_000 });
  await sendShipmentRequest(database, purchase);
  const sale = await seedContract(database, { no: "SC-EDIT-01/CONTOH", direction: "OUT", partnerId: companies.customer1, productId: products.olein, qty: 1_000_000 });
  const created = await call("POST", "/api/delivery-orders", "logistics", {
    doDate: "2026-11-20", contractId: sale, qty: 90_000, ...DESTINATION, deliveryFrom: "2026-11-20", deliveryUntil: "2026-11-30", transporterId: companies.transporter1,
  });
  const order = created.json().deliveryOrder as { id: number };
  await call("POST", `/api/delivery-orders/${order.id}/send`, "logistics", {});
  await call("POST", `/api/delivery-orders/${order.id}/accept`, "angkut1", {});

  const vehicles: number[] = [];
  const drivers: number[] = [];
  for (const n of [1, 2, 3, 4, 5]) {
    vehicles.push(await seedVehicle(database, { plate: `BK 310${n} ED`, ownerId: companies.transporter1, capacityKg: 32_000 }));
    drivers.push(await seedDriver(database, { name: `Supir Ubah ${n}`, licence: `SIMEDIT00${n}` }));
  }
  for (const n of [1, 2, 3]) await seedCard(database, `CE000000000${n}`, `K-E${n}`);

  const incoming = (vehicle = vehicles[0], netKg = 30_000, extra: object = {}) => ({
    direction: "IN",
    submit: true,
    plannedDate: "2026-11-22",
    allocations: [{ contractId: purchase }],
    trips: [{ vehicle: { id: vehicle }, driver: { id: drivers[0] }, letters: [{ allocationSeq: 1, originGrossKg: netKg + 12_000, originTareKg: 12_000, originNetKg: netKg }] }],
    ...extra,
  });
  const truck = (index: number, extra: object = {}) => ({ vehicle: { id: vehicles[index] }, driver: { id: drivers[index] }, plannedArrival: "2026-11-22", ...extra });
  const outgoing = (trips: object[], extra: object = {}) => ({
    direction: "OUT",
    submit: true,
    plannedDate: "2026-11-22",
    allocations: [{ deliveryOrderId: order.id, qtyPlanned: 60_000 }],
    trips,
    ...extra,
  });
  const created201 = async (as: string, body: object) => {
    const response = await call("POST", "/api/registrations", as, body);
    if (response.statusCode !== 201) throw new Error(response.body);
    return response.json().registration as Shown;
  };
  const show = async (id: number, as = "logistics") => (await call("GET", `/api/registrations/${id}`, as)).json().registration as Shown;
  const audit = async (id: number) =>
    database.query<{ action: string; before: { trips: { status: string }[] }; after: { trips: { status: string }[] } }>(
      "select action, before, after from audit_log where entity_type = 'registration' and entity_id = $1 and action = 'REGISTRATION_CHANGED' order by id",
      [id],
    );
  return { ...context, order, purchase, vehicles, drivers, incoming, truck, outgoing, created201, show, audit };
}

describe("changing a registration after it was sent", () => {
  it("changes an approved registration before check-in and keeps the same barcode", async () => {
    const { call, created201, incoming, show, audit } = await setup();
    const sent = await created201("pks1", incoming());
    expect(sent.status).toBe("APPROVED");
    const [trip] = sent.trips;
    expect(trip?.edit).toEqual({ allowed: true, reason: null });
    expect(sent.edit).toEqual({ allowed: true, allocationsLocked: false, reason: null });

    const changed = await call("PUT", `/api/registrations/${sent.id}`, "pks1", {
      ...incoming(undefined, 29_500, { remark: "Netto surat dikoreksi" }),
      trips: [{ ...incoming(undefined, 29_500).trips[0], id: trip?.id }],
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().spjChanges).toEqual([]);
    const after = changed.json().registration as Shown & { trips: (Trip & { docNetKg: number })[] };
    expect(after).toMatchObject({ status: "APPROVED", remark: "Netto surat dikoreksi" });
    expect(after.trips).toHaveLength(1);
    expect(after.trips[0]).toMatchObject({ id: trip?.id, status: "ISSUED", docNetKg: 29_500, spj: { barcodeToken: trip?.spj?.barcodeToken, spjNo: trip?.spj?.spjNo } });
    const [row] = await audit(sent.id);
    expect(row?.action).toBe("REGISTRATION_CHANGED");
    expect((await show(sent.id, "pks1")).trips[0]?.spj?.barcodeToken).toBe(trip?.spj?.barcodeToken);
  });

  it("gives a truck whose vehicle changed a new SPJ, and the gate refuses the old barcode", async () => {
    const { call, created201, incoming, vehicles } = await setup();
    const sent = await created201("pks1", incoming());
    const [trip] = sent.trips;
    const old = trip?.spj?.barcodeToken as string;
    const changed = await call("PUT", `/api/registrations/${sent.id}`, "pks1", { ...incoming(vehicles[1]), trips: [{ ...incoming(vehicles[1]).trips[0], id: trip?.id }] });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().spjChanges).toEqual([{ tripId: trip?.id, seq: 1, plateNo: "BK3102ED", change: "REISSUED" }]);
    const shown = (changed.json().registration as Shown).trips[0];
    expect(shown?.vehicle?.id).toBe(vehicles[1]);
    expect(shown?.spj?.barcodeToken).not.toBe(old);

    const refused = await call("POST", "/api/gate/check-in", "pos", { token: old, cardUid: "CE0000000001" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("SPJ_REVOKED");
    const checkedIn = await call("POST", "/api/gate/check-in", "pos", { token: shown?.spj?.barcodeToken, cardUid: "CE0000000001" });
    expect(checkedIn.statusCode, checkedIn.body).toBe(200);
  });

  it("locks a truck that checked in: it is not changed, the contracts and DOs are fixed, the other trucks still change", async () => {
    const { call, created201, outgoing, truck, show, order } = await setup();
    const sent = await created201("angkut1", outgoing([truck(0), truck(1)]));
    expect(sent.status, JSON.stringify(sent.findings)).toBe("APPROVED");
    const [first, second] = sent.trips;
    const checkedIn = await call("POST", "/api/gate/check-in", "pos", { token: first?.spj?.barcodeToken, cardUid: "CE0000000001", closeCargo: false, flexiBag: false });
    expect(checkedIn.statusCode, checkedIn.body).toBe(200);

    const detail = await show(sent.id, "angkut1");
    expect(detail.trips.map((trip) => trip.edit)).toEqual([
      { allowed: false, reason: "Truk sudah check-in di pos." },
      { allowed: true, reason: null },
    ]);
    expect(detail.edit).toEqual({ allowed: true, allocationsLocked: true, reason: null });

    const locked = await call("PUT", `/api/registrations/${sent.id}`, "angkut1", outgoing([truck(0, { id: first?.id }), truck(1, { id: second?.id })]));
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error).toEqual({ code: "TRIP_LOCKED", message: "Truk BK3101ED sudah check-in di pos dan tidak bisa diubah." });
    const otherDo = await call("PUT", `/api/registrations/${sent.id}`, "angkut1", outgoing([truck(1, { id: second?.id })], { allocations: [{ deliveryOrderId: order.id + 999, qtyPlanned: 1 }] }));
    expect(otherDo.statusCode).toBe(409);
    expect(otherDo.json().error.code).toBe("ALLOCATIONS_LOCKED");
    // the truck that checked in stays as it is; the other one changes its driver
    const changed = await call("PUT", `/api/registrations/${sent.id}`, "angkut1", outgoing([truck(1, { id: second?.id, driver: { id: undefined } })], {}));
    expect(changed.statusCode).toBe(400);
    const ok = await call("PUT", `/api/registrations/${sent.id}`, "angkut1", { ...outgoing([{ ...truck(1, { id: second?.id }), remark: "Supir ganti jam" }]), allocations: [{ deliveryOrderId: order.id, qtyPlanned: 30_000 }] });
    expect(ok.statusCode, ok.body).toBe(200);
    const trips = (ok.json().registration as Shown).trips;
    expect(trips.map((trip) => [trip.id, trip.status])).toEqual([
      [first?.id, "CHECKED_IN"],
      [second?.id, "ISSUED"],
    ]);
  });

  it("adds a truck within the DO, and removes one, with the SPJ of each told", async () => {
    const { call, created201, outgoing, truck, order } = await setup();
    const sent = await created201("angkut1", outgoing([truck(0), truck(1)]));
    const [first, second] = sent.trips;
    const added = await call("PUT", `/api/registrations/${sent.id}`, "angkut1", outgoing([truck(0, { id: first?.id }), truck(1, { id: second?.id }), truck(2)], { allocations: [{ deliveryOrderId: order.id, qtyPlanned: 90_000 }] }));
    expect(added.statusCode, added.body).toBe(200);
    const after = added.json().registration as Shown & { trips: (Trip & { qtyPlanned: number })[] };
    expect(after.status).toBe("APPROVED");
    expect(after.trips.map((trip) => [trip.seq, trip.status, trip.qtyPlanned])).toEqual([
      [1, "ISSUED", 30_000],
      [2, "ISSUED", 30_000],
      [3, "ISSUED", 30_000],
    ]);
    expect(added.json().spjChanges).toEqual([{ tripId: after.trips[2]?.id, seq: 3, plateNo: "BK3103ED", change: "ISSUED" }]);
    // the barcodes of the first two stay
    expect(after.trips[0]?.spj?.barcodeToken).toBe(first?.spj?.barcodeToken);

    const removed = await call("PUT", `/api/registrations/${sent.id}`, "angkut1", outgoing([truck(0, { id: first?.id }), truck(2, { id: after.trips[2]?.id })], { allocations: [{ deliveryOrderId: order.id, qtyPlanned: 60_000 }] }));
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().spjChanges).toEqual([{ tripId: second?.id, seq: 2, plateNo: "BK3102ED", change: "CANCELLED" }]);
    expect((removed.json().registration as Shown).trips.map((trip) => trip.status)).toEqual(["ISSUED", "CANCELLED", "ISSUED"]);
    const refused = await call("POST", "/api/gate/check-in", "pos", { token: second?.spj?.barcodeToken, cardUid: "CE0000000002" });
    expect(refused.json().error.code).toBe("SPJ_REVOKED");
  });

  it("sends a change that brings a new finding back to logistics review, without SPJ until approved", async () => {
    const { call, created201, incoming } = await setup();
    const sent = await created201("pks1", incoming());
    const [trip] = sent.trips;
    // 120.000 kg on a contract of 100.000 kg
    const over = await call("PUT", `/api/registrations/${sent.id}`, "pks1", { ...incoming(undefined, 120_000), trips: [{ ...incoming(undefined, 120_000).trips[0], id: trip?.id }] });
    expect(over.statusCode, over.body).toBe(200);
    expect(over.json().spjChanges).toEqual([{ tripId: trip?.id, seq: 1, plateNo: "BK3101ED", change: "WITHDRAWN" }]);
    const waiting = over.json().registration as Shown;
    expect(waiting.status).toBe("SUBMITTED");
    expect(waiting.findings.map((finding) => finding.code)).toEqual(["OVER_CONTRACT"]);
    expect(waiting.trips[0]).toMatchObject({ status: "READY", spj: null });
    expect((await call("POST", "/api/gate/check-in", "pos", { token: trip?.spj?.barcodeToken, cardUid: "CE0000000001" })).json().error.code).toBe("SPJ_REVOKED");

    const approved = await call("POST", `/api/registrations/${sent.id}/approve`, "peninjau", { note: "Kontrak ditambah" });
    expect(approved.json().registration.trips[0]).toMatchObject({ status: "ISSUED", spj: { spjNo: expect.any(String) } });
    // the same finding again does not send it back
    const again = await call("PUT", `/api/registrations/${sent.id}`, "pks1", { ...incoming(undefined, 119_000), trips: [{ ...incoming(undefined, 119_000).trips[0], id: trip?.id }] });
    expect(again.json().registration.status).toBe("APPROVED");
    expect(again.json().spjChanges).toEqual([]);
  });

  it("lets staff with registrations EDIT change a partner's registration; CREATE alone is not enough", async () => {
    const { call, created201, incoming } = await setup();
    const sent = await created201("pks1", incoming());
    const [trip] = sent.trips;
    const body = { ...incoming(undefined, 30_000, { remark: "Dibetulkan logistik" }), trips: [{ ...incoming().trips[0], id: trip?.id }] };
    expect((await call("PUT", `/api/registrations/${sent.id}`, "pembuat", body)).statusCode).toBe(403);
    const byStaff = await call("PUT", `/api/registrations/${sent.id}`, "peninjau", body);
    expect(byStaff.statusCode, byStaff.body).toBe(200);
    expect(byStaff.json().registration).toMatchObject({ remark: "Dibetulkan logistik", originPartner: { name: "PT Sawit Satu" } });
    // another supplier does not reach it
    expect((await call("PUT", `/api/registrations/${sent.id}`, "pks2", body)).statusCode).toBe(404);
    // a cancelled registration does not change any more
    await call("POST", `/api/registrations/${sent.id}/cancel`, "pks1", { reason: "Batal kirim" });
    const cancelled = await call("PUT", `/api/registrations/${sent.id}`, "pks1", body);
    expect(cancelled.statusCode).toBe(409);
    expect(cancelled.json().error.code).toBe("INVALID_STATE");
  });

  it("refuses to change an incoming registration whose truck checked in", async () => {
    const { call, created201, incoming } = await setup();
    const sent = await created201("pks1", incoming());
    const [trip] = sent.trips;
    await call("POST", "/api/gate/check-in", "pos", { token: trip?.spj?.barcodeToken, cardUid: "CE0000000001" });
    const refused = await call("PUT", `/api/registrations/${sent.id}`, "pks1", { ...incoming(), trips: [{ ...incoming().trips[0], id: trip?.id }] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toEqual({ code: "REGISTRATION_LOCKED", message: "Truk BK3101ED sudah check-in di pos dan tidak bisa diubah. Registrasi ini tidak bisa diubah lagi." });
    expect((await call("GET", `/api/registrations/${sent.id}`, "pks1")).json().registration.edit).toEqual({ allowed: false, allocationsLocked: true, reason: "Truk sudah check-in di pos." });
  });
});
