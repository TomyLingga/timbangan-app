import { describe, expect, it } from "vitest";
import { DESTINATION, phase3App, seedContract, seedDestination, seedDriver, seedVehicle, sendShipmentRequest } from "./helpers/fixtures.js";

// the test clock starts at 2026-11-20T03:00Z, 10:00 at the plant
const TODAY = "2026-11-20";

async function setup() {
  // qc keeps a permission that is neither gate nor registrations
  const context = await phase3App({}, { qc: { contracts: "VIEW" } });
  const { database, companies, products, call } = context;
  const purchase1 = await seedContract(database, { no: "PC-701/CONTOH", partnerId: companies.supplier1, productId: products.cpo, qty: 1_000_000 });
  const purchase2 = await seedContract(database, { no: "PC-702/CONTOH", partnerId: companies.supplier2, productId: products.cpo, qty: 1_000_000 });
  // INL sent each supplier a request on its contract (0017)
  for (const contractId of [purchase1, purchase2]) await sendShipmentRequest(database, contractId);
  const sale = await seedContract(database, { no: "SC-701/CONTOH", direction: "OUT", partnerId: companies.customer1, productId: products.olein, qty: 1_000_000 });
  const place = await seedDestination(database, "Gudang Alur Contoh");

  // every truck has its own vehicle and driver: one vehicle or driver is inside the plant only once
  let serial = 0;
  const truck = async (type = "TANGKI") => {
    serial++;
    const vehicle = await seedVehicle(database, { plate: `BK ${4000 + serial} FL`, ownerId: companies.transporter1, type });
    const driver = await seedDriver(database, { name: `Supir Alur ${serial}`, licence: `SIMALUR${String(serial).padStart(4, "0")}` });
    return { vehicle: { id: vehicle }, driver: { id: driver } };
  };

  const incoming = async (plannedDate = TODAY, as: "pks1" | "pks2" = "pks1") => {
    const response = await call("POST", "/api/registrations", as, {
      direction: "IN",
      submit: true,
      plannedDate,
      transporterId: companies.transporter1,
      allocations: [{ contractId: as === "pks1" ? purchase1 : purchase2 }],
      trips: [{ ...(await truck()), letters: [{ allocationSeq: 1, originNetKg: 25_000 }] }],
    });
    if (response.statusCode !== 201) throw new Error(response.body);
    return response.json().registration.trips[0].id as number;
  };

  const outgoing = async (plannedDate = TODAY) => {
    const order = (await call("POST", "/api/delivery-orders", "logistics", { doDate: TODAY, contractId: sale, qty: 30_000, ...DESTINATION, deliveryFrom: TODAY, transporterId: companies.transporter1 })).json().deliveryOrder;
    await call("POST", `/api/delivery-orders/${order.id}/send`, "logistics", {});
    await call("POST", `/api/delivery-orders/${order.id}/accept`, "angkut1", {});
    const response = await call("POST", "/api/registrations", "angkut1", {
      direction: "OUT", submit: true, closeCargo: true, flexiBag: true, plannedDate,
      allocations: [{ deliveryOrderId: order.id }],
      trips: [await truck("BOX")],
    });
    if (response.statusCode !== 201) throw new Error(response.body);
    return response.json().registration.trips[0].id as number;
  };

  /** Puts the truck inside the plant at a step, the way check-in and the field steps leave it. */
  const inside = async (tripId: number, status: "CHECKED_IN" | "IN_PROCESS", step: string | null) => {
    await database.query("update trips set status = $2, checked_in_at = $3, current_step = $4 where id = $1", [tripId, status, "2026-11-20T01:00:00Z", step]);
  };
  /** Closes the trip the way check-out does, at `at`. */
  const finished = async (tripId: number, status: "COMPLETED" | "REJECTED", at: string) => {
    await database.query("update trips set status = $2, outcome = $3, checked_in_at = $4, current_step = null, completed_at = $4, exited_at = $4 where id = $1", [
      tripId, status, status === "COMPLETED" ? "OK" : "SPEC_REJECT", at,
    ]);
  };
  const flow = (as = "pos") => call("GET", "/api/trips/flow", as);
  return { ...context, incoming, outgoing, inside, finished, flow };
}

describe("GET /api/trips/flow", () => {
  it("counts the trucks expected today, inside by step and direction, and finished today", async () => {
    const { incoming, outgoing, inside, finished, flow, call, database } = await setup();

    // inside the plant: three steps, both directions, two companies, and one truck without a step yet
    await inside(await incoming(), "CHECKED_IN", "WEIGH_1");
    await inside(await incoming(), "IN_PROCESS", "WEIGH_1");
    await inside(await incoming(TODAY, "pks2"), "IN_PROCESS", "WEIGH_1");
    await inside(await incoming(), "IN_PROCESS", "QC");
    await inside(await incoming(), "CHECKED_IN", null);
    await inside(await outgoing(), "CHECKED_IN", "WEIGH_1");
    await inside(await outgoing(), "IN_PROCESS", "WEIGH_2");

    // expected today: an issued SPJ, one past its validity (the gate lists both), and not for another day
    await incoming();
    const expired = await incoming();
    await database.query("update trips set status = 'EXPIRED' where id = $1", [expired]);
    await outgoing();
    await incoming("2026-11-21");
    await outgoing("2026-11-21");
    const cancelled = await incoming();
    await database.query("update trips set status = 'CANCELLED', cancelled_at = now() where id = $1", [cancelled]);

    // left the plant: 00:30 today at the plant counts, 23:30 yesterday does not
    await finished(await incoming(), "COMPLETED", "2026-11-19T17:30:00Z");
    await finished(await incoming(), "REJECTED", "2026-11-20T02:00:00Z");
    await finished(await incoming(), "COMPLETED", "2026-11-19T16:30:00Z");
    await finished(await outgoing(), "COMPLETED", "2026-11-20T02:30:00Z");

    const response = await flow();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      date: TODAY,
      upcoming: { in: 2, out: 1 },
      inside: [
        { stepCode: "QC", in: 1, out: 0 },
        { stepCode: "WEIGH_1", in: 3, out: 1 },
        { stepCode: "WEIGH_2", in: 0, out: 1 },
        { stepCode: null, in: 1, out: 0 },
      ],
      finishedToday: { in: 2, out: 1 },
    });

    // the same number as the gate's "akan datang hari ini" list
    const gate = (await call("GET", `/api/trips?status=ISSUED,EXPIRED&date=${TODAY}`, "pos")).json();
    expect(gate.total).toBe(3);
  });

  it("answers zeros and no steps on an empty day", async () => {
    const { flow } = await setup();
    expect((await flow()).json()).toEqual({ date: TODAY, upcoming: { in: 0, out: 0 }, inside: [], finishedToday: { in: 0, out: 0 } });
  });

  it("moves to the next plant day at midnight there", async () => {
    const { incoming, flow, clock } = await setup();
    await incoming();
    // 17:00Z is midnight at the plant: the truck planned for the 20th is no longer expected today
    clock.advance(14 * 3_600_000);
    expect((await flow()).json()).toMatchObject({ date: "2026-11-21", upcoming: { in: 0, out: 0 } });
  });

  it("is for staff with gate or registrations at view level, like the list", async () => {
    const { flow, incoming } = await setup();
    await incoming(TODAY, "pks1");
    await incoming(TODAY, "pks2");
    // the list of trips is staff only, so a partner account gets no counts at all, not even of its own trucks
    const partner = await flow("pks1");
    expect(partner.statusCode).toBe(403);
    expect(partner.json().error.code).toBe("FORBIDDEN");
    expect((await flow("angkut1")).statusCode).toBe(403);
    const without = await flow("qc");
    expect(without.statusCode).toBe(403);
    expect(without.json().error.code).toBe("FORBIDDEN");
    expect((await flow("logistics")).json().upcoming).toEqual({ in: 2, out: 0 });
    expect((await flow("pos")).json().upcoming).toEqual({ in: 2, out: 0 });
  });
});
