import { describe, expect, it } from "vitest";
import { phase3App, seedContract, seedDestination, seedDriver, seedVehicle } from "./helpers/fixtures.js";

async function setup() {
  const context = await phase3App();
  const { database, companies, products, call } = context;
  const sale = await seedContract(database, { no: "SC-401/CONTOH", direction: "OUT", partnerId: companies.customer1, productId: products.olein, qty: 1_000_000 });
  const place = await seedDestination(database, "Gudang Contoh");
  /** A DO sent to the transporter and, unless told otherwise, accepted by it. */
  const acceptedDo = async (qty: number, options: { transporter?: number; product?: number; deliveryUntil?: string; accept?: boolean } = {}) => {
    const transporter = options.transporter ?? companies.transporter1;
    const created = await call("POST", "/api/delivery-orders", "logistics", {
      doDate: "2026-11-20",
      ...(options.product ? { partnerId: companies.customer2, productId: options.product } : { contractId: sale }),
      qty,
      destinationId: place,
      deliveryFrom: "2026-11-20",
      deliveryUntil: options.deliveryUntil ?? "2026-11-30",
      transporterId: transporter,
    });
    if (created.statusCode !== 201) throw new Error(created.body);
    const order = created.json().deliveryOrder as { id: number; doNo: string };
    await call("POST", `/api/delivery-orders/${order.id}/send`, "logistics", {});
    if (options.accept !== false) await call("POST", `/api/delivery-orders/${order.id}/accept`, transporter === companies.transporter2 ? "angkut2" : "angkut1", {});
    return order;
  };
  const vehicles: number[] = [];
  const drivers: number[] = [];
  for (const n of [1, 2, 3, 4, 5]) {
    vehicles.push(await seedVehicle(database, { plate: `BK 200${n} BB`, ownerId: companies.transporter1, capacityKg: n === 5 ? 20_000 : 32_000 }));
    drivers.push(await seedDriver(database, { name: `Supir Keluar ${n}`, licence: `SIMOUT000${n}` }));
  }
  const trucks = (count: number, over: object = {}, from = 0) =>
    Array.from({ length: count }, (_, index) => ({ vehicle: { id: vehicles[from + index] }, driver: { id: drivers[from + index] }, plannedArrival: "2026-11-22", ...over }));
  const outgoing = (allocations: object[], truckCount: number, extra: object = {}) => ({
    direction: "OUT",
    submit: true,
    closeCargo: true,
    flexiBag: false,
    plannedDate: "2026-11-22",
    allocations,
    trips: trucks(truckCount),
    ...extra,
  });
  const register = async (body: object, as = "angkut1") => call("POST", "/api/registrations", as, body);
  const registerOk = async (body: object, as = "angkut1") => {
    const response = await register(body, as);
    if (response.statusCode !== 201) throw new Error(response.body);
    return response.json().registration;
  };
  const deliveryOrder = async (id: number) => (await call("GET", `/api/delivery-orders/${id}`)).json();
  const count = async (table: string) => Number((await database.query<{ n: number }>(`select count(*)::int as n from ${table}`))[0]?.n);
  return { ...context, sale, place, acceptedDo, vehicles, drivers, trucks, outgoing, register, registerOk, deliveryOrder, count };
}

type Shown = { status: string; findings: { code: string }[]; trips: { qtyPlanned: number; status: string; allocations: { qtyPlanned: number }[] }[] };
const shares = (registration: Shown) => registration.trips.map((trip) => trip.allocations.map((allocation) => allocation.qtyPlanned));
const codes = (registration: Shown) => registration.findings.map((finding) => finding.code).sort();

describe("outgoing registration", () => {
  it("splits the DO quantity evenly over the trucks, the remainder on the last, and issues an SPJ per truck", async () => {
    const { acceptedDo, registerOk, outgoing, deliveryOrder, companies } = await setup();
    const order = await acceptedDo(100_003.5);
    const registration = await registerOk(outgoing([{ deliveryOrderId: order.id }], 4));
    expect(registration).toMatchObject({
      direction: "OUT",
      flowCode: "OUT_BULK",
      status: "APPROVED",
      partner: { id: companies.customer1 },
      transporter: { id: companies.transporter1 },
      truckCount: 4,
      qtyTotal: 100003.5,
      closeCargo: true,
      flexiBag: false,
      createdVia: "PORTAL",
      findings: [],
      allocations: [{ seq: 1, deliveryOrder: { id: order.id, doNo: order.doNo }, doNo: order.doNo, contractNo: "SC-401/CONTOH", qtyPlanned: 100003.5, product: { category: "BULK_LIQUID" } }],
    });
    expect(shares(registration)).toEqual([[25000], [25000], [25000], [25003.5]]);
    expect(registration.trips.map((trip: { qtyPlanned: number }) => trip.qtyPlanned)).toEqual([25000, 25000, 25000, 25003.5]);
    expect(registration.trips.every((trip: { status: string; spj: unknown }) => trip.status === "ISSUED" && trip.spj !== null)).toBe(true);
    expect(new Set(registration.trips.map((trip: { spj: { spjNo: string } }) => trip.spj.spjNo)).size).toBe(4);

    const detail = await deliveryOrder(order.id);
    expect(detail.deliveryOrder).toMatchObject({ qtyPlanned: 100003.5, qtyRemaining: 0, tripCount: 4 });
    expect(detail.trips.map((trip: { seq: number }) => trip.seq)).toEqual([1, 2, 3, 4]);
  });

  it("carries several DOs on each truck, takes the DO's remainder when no quantity is given, and rounds down to whole units", async () => {
    const { acceptedDo, registerOk, outgoing, products, deliveryOrder } = await setup();
    const first = await acceptedDo(60_000);
    const second = await acceptedDo(9_001);
    const registration = await registerOk(outgoing([{ deliveryOrderId: first.id, qtyPlanned: 40_000 }, { deliveryOrderId: second.id }], 2));
    expect(shares(registration)).toEqual([[20000, 4500], [20000, 4501]]);
    expect(registration.trips.map((trip: { qtyPlanned: number }) => trip.qtyPlanned)).toEqual([24500, 24501]);

    // a DO may get several lists: the next one takes what is left
    const next = await registerOk(outgoing([{ deliveryOrderId: first.id }], 1));
    expect(shares(next)).toEqual([[20000]]);
    expect((await deliveryOrder(first.id)).deliveryOrder).toMatchObject({ qtyPlanned: 60000, qtyRemaining: 0, tripCount: 3 });

    const boxes = await acceptedDo(10, { product: products.packed });
    const packed = await registerOk(outgoing([{ deliveryOrderId: boxes.id }], 3));
    expect(packed).toMatchObject({ flowCode: "OUT_PACKED", uom: "karton" });
    expect(shares(packed)).toEqual([[3], [3], [4]]);
  });

  it("finds OVER_DO against what other lists still hold, OVER_CAPACITY and OUTSIDE_DELIVERY_WINDOW", async () => {
    const { acceptedDo, registerOk, outgoing, trucks, call } = await setup();
    const order = await acceptedDo(50_000, { deliveryUntil: "2026-11-25" });
    const held = await registerOk(outgoing([{ deliveryOrderId: order.id, qtyPlanned: 40_000 }], 2));
    expect(held.findings).toEqual([]);
    const over = await registerOk(outgoing([{ deliveryOrderId: order.id, qtyPlanned: 20_000 }], 1));
    expect(over).toMatchObject({ status: "SUBMITTED", findings: [{ code: "OVER_DO", allocationSeq: 1 }], trips: [{ status: "READY", spj: null }] });

    // a cancelled list gives its quantity back
    await call("POST", `/api/registrations/${held.id}/cancel`, "angkut1", { reason: "batal" });
    expect((await registerOk(outgoing([{ deliveryOrderId: order.id, qtyPlanned: 20_000 }], 1))).findings).toEqual([]);

    // the fifth truck carries 20 000 kg at most
    const late = await registerOk(outgoing([{ deliveryOrderId: order.id, qtyPlanned: 25_000 }], 1, { trips: trucks(1, { plannedArrival: "2026-11-26" }, 4) }));
    expect(codes(late)).toEqual(["OUTSIDE_DELIVERY_WINDOW", "OVER_CAPACITY", "OVER_DO"]);
    expect(late.findings.find((finding: { code: string }) => finding.code === "OVER_CAPACITY")).toMatchObject({ tripSeq: 1 });
    expect(late.findings.find((finding: { code: string }) => finding.code === "OUTSIDE_DELIVERY_WINDOW")).toMatchObject({ tripSeq: 1, allocationSeq: 1 });
  });

  it("needs close cargo and flexi bag at submit, not in a draft", async () => {
    const { acceptedDo, register, registerOk, outgoing, call } = await setup();
    const order = await acceptedDo(30_000);
    const missing = await register(outgoing([{ deliveryOrderId: order.id }], 1, { closeCargo: undefined, flexiBag: undefined }));
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.fields.map((field: { field: string }) => field.field)).toEqual(["closeCargo", "flexiBag"]);

    const draft = await registerOk(outgoing([{ deliveryOrderId: order.id }], 1, { closeCargo: undefined, flexiBag: undefined, submit: false }));
    expect(draft.status).toBe("DRAFT");
    expect((await call("POST", `/api/registrations/${draft.id}/submit`, "angkut1")).statusCode).toBe(400);
    const filled = await call("PUT", `/api/registrations/${draft.id}`, "angkut1", outgoing([{ deliveryOrderId: order.id }], 1, { closeCargo: false, flexiBag: true }));
    expect(filled.statusCode).toBe(200);
    expect(filled.json().registration).toMatchObject({ status: "APPROVED", closeCargo: false, flexiBag: true });
  });

  it("refuses the same truck or driver twice, a DO that is not accepted or not the transporter's, and a quantity too small to split", async () => {
    const { acceptedDo, register, outgoing, vehicles, drivers, companies, count } = await setup();
    const order = await acceptedDo(30_000);
    const sameVehicle = await register(outgoing([{ deliveryOrderId: order.id }], 2, { trips: [{ vehicle: { id: vehicles[0] }, driver: { id: drivers[0] } }, { vehicle: { id: vehicles[0] }, driver: { id: drivers[1] } }] }));
    expect(sameVehicle.statusCode).toBe(409);
    expect(sameVehicle.json().error.code).toBe("DUPLICATE_VEHICLE");
    const sameDriver = await register(outgoing([{ deliveryOrderId: order.id }], 2, { trips: [{ vehicle: { id: vehicles[0] }, driver: { id: drivers[0] } }, { vehicle: { id: vehicles[1] }, driver: { id: drivers[0] } }] }));
    expect(sameDriver.json().error.code).toBe("DUPLICATE_DRIVER");

    const notAccepted = await acceptedDo(30_000, { accept: false });
    const otherTransporter = await acceptedDo(30_000, { transporter: companies.transporter2 });
    for (const id of [notAccepted.id, otherTransporter.id, 999_999]) {
      const response = await register(outgoing([{ deliveryOrderId: id }], 1));
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("DO_NOT_AVAILABLE");
    }
    const tiny = await register(outgoing([{ deliveryOrderId: order.id, qtyPlanned: 3 }], 4));
    expect(tiny.statusCode).toBe(400);
    expect(tiny.json().error.fields[0].field).toBe("allocations.0.qtyPlanned");
    expect(await count("registrations")).toBe(0);
  });

  it("keeps one flow per registration and is open to transporters and registration staff, not to suppliers", async () => {
    const { acceptedDo, register, registerOk, outgoing, products, companies } = await setup();
    const bulk = await acceptedDo(30_000);
    const boxes = await acceptedDo(30, { product: products.packed });
    const mixed = await register(outgoing([{ deliveryOrderId: bulk.id }, { deliveryOrderId: boxes.id }], 1));
    expect(mixed.statusCode).toBe(400);
    expect(mixed.json().error.fields[0].field).toBe("allocations");

    expect((await register(outgoing([{ deliveryOrderId: bulk.id }], 1), "pks1")).statusCode).toBe(403);
    const byStaff = await registerOk(outgoing([{ deliveryOrderId: bulk.id }], 1), "pos");
    expect(byStaff).toMatchObject({ createdVia: "OPERATOR", transporter: { id: companies.transporter1 } });

    const otherTransporter = await acceptedDo(30_000, { transporter: companies.transporter2 });
    const twoTransporters = await register(outgoing([{ deliveryOrderId: bulk.id }, { deliveryOrderId: otherTransporter.id }], 1), "pos");
    expect(twoTransporters.statusCode).toBe(400);
  });

  it("shows a transporter only its own lists and the DOs sent to it", async () => {
    const { acceptedDo, registerOk, outgoing, call, companies } = await setup();
    const own = await registerOk(outgoing([{ deliveryOrderId: (await acceptedDo(30_000)).id }], 1));
    const other = await acceptedDo(30_000, { transporter: companies.transporter2 });
    const ids = async (as: string) => (await call("GET", "/api/registrations?direction=OUT", as)).json().items.map((item: { id: number }) => item.id);
    expect(await ids("angkut1")).toEqual([own.id]);
    expect(await ids("angkut2")).toEqual([]);
    expect(await ids("pks1")).toEqual([]);
    expect((await call("GET", `/api/registrations/${own.id}`, "angkut2")).statusCode).toBe(404);
    expect((await call("GET", `/api/delivery-orders/${other.id}`, "angkut1")).statusCode).toBe(404);
  });
});

describe("cancelling a DO with trucks registered", () => {
  it("cancels the trucks that have not arrived and revokes their SPJ; refuses once a truck checked in", async () => {
    const { acceptedDo, registerOk, outgoing, call, database } = await setup();
    const order = await acceptedDo(40_000);
    const registration = await registerOk(outgoing([{ deliveryOrderId: order.id }], 2));
    const cancelled = await call("POST", `/api/delivery-orders/${order.id}/cancel`, "logistics", { reason: "pembeli menunda" });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().deliveryOrder).toMatchObject({ status: "CANCELLED", qtyPlanned: 0, tripCount: 0 });
    const detail = (await call("GET", `/api/registrations/${registration.id}`, "angkut1")).json().registration;
    expect(detail.trips.map((trip: { status: string; spj: unknown }) => [trip.status, trip.spj])).toEqual([["CANCELLED", null], ["CANCELLED", null]]);

    const second = await acceptedDo(40_000);
    const arrived = await registerOk(outgoing([{ deliveryOrderId: second.id }], 1));
    await database.query("update trips set status = 'CHECKED_IN' where registration_id = $1", [arrived.id]);
    const refused = await call("POST", `/api/delivery-orders/${second.id}/cancel`, "logistics", { reason: "x" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("INVALID_STATE");
  });
});
