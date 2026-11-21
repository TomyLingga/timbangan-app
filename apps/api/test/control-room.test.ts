// The control room: where each truck inside the plant is drawn, the figures around the map, the recent step
// changes, one trip's timeline, the plan drawing, and who may open them.
import { describe, expect, it } from "vitest";
import { DEMO_ZONE_SHAPES } from "../src/control-room/demo-plan.js";
import { testApp } from "./helpers/app.js";
import { bearer, seedPartner, seedPartnerUser, seedStaff } from "./helpers/users.js";
import { seedBase, seedException, seedTrip, seedWeighing } from "./control-room-fixtures.js";

// the test clock stands at 2026-11-20 03:00 UTC, 10:00 at the plant
const AT = (time: string) => `2026-11-20T${time}Z`;

async function setup() {
  const ctx = await testApp();
  const base = await seedBase(ctx.database);
  await seedStaff(ctx.database, "kontrol", { dashboard: "VIEW" });
  const headers = await bearer(ctx.app, "kontrol");
  const get = (url: string) => ctx.app.inject({ method: "GET", url, headers });
  const state = async () => {
    const response = await get("/api/control-room/state");
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as State;
  };
  return { ...ctx, base, headers, get, state };
}

interface Truck {
  tripId: number;
  tripNo: string | null;
  plateNo: string;
  plateDisplay: string;
  direction: "IN" | "OUT";
  flowCode: string;
  zone: string;
  stepCode: string | null;
  stepName: string | null;
  stepStatus: string | null;
  since: string;
  held: { type: string; since: string } | null;
}
interface State {
  generatedAt: string;
  plantDay: string;
  zones: { code: string; name: string; kind: string; color: string | null; shape: number[][] | null }[];
  trucks: Truck[];
  upcoming: { in: number; out: number };
  kpi: { inside: number; upcoming: number; pendingDecisions: number; finishedToday: number; avgMinutesInPlantToday: number | null };
  zoneStats: { zone: string; count: number; longest: { tripId: number; plateDisplay: string; minutes: number } | null }[];
  recent: { at: string; tripId: number; plateDisplay: string; text: string }[];
}

const truckOf = (state: State, tripId: number) => state.trucks.find((truck) => truck.tripId === tripId);

describe("GET /api/control-room/state: position of each truck", () => {
  it("draws a truck that checked in and has no step waiting or running at the registration post", async () => {
    const { database, base, state } = await setup();
    const { tripId } = await seedTrip(database, base, { plate: "ZZ 1001 AA", checkedInAt: AT("02:10:00"), steps: [{ code: "SEAL_CHECK", status: "PENDING" }] });
    const truck = truckOf(await state(), tripId);
    expect(truck).toMatchObject({ zone: "REG", stepCode: null, stepStatus: null, since: AT("02:10:00.000"), held: null, plateDisplay: "ZZ 1001 AA", plateNo: "ZZ1001AA", direction: "IN", flowCode: "IN_CPO" });
  });

  it("draws a READY step in its waiting zone and an IN_PROGRESS step in its work zone, since the step became so", async () => {
    const { database, base, state } = await setup();
    const waiting = await seedTrip(database, base, {
      plate: "ZZ 1002 AA",
      steps: [
        { code: "SEAL_CHECK", status: "DONE", result: "PASS", readyAt: AT("01:00:00"), startedAt: AT("01:05:00"), finishedAt: AT("01:10:00") },
        { code: "WEIGH_1", status: "READY", readyAt: AT("01:10:00") },
      ],
    });
    const working = await seedTrip(database, base, {
      plate: "ZZ 1003 AA",
      steps: [{ code: "UNLOADING", status: "IN_PROGRESS", readyAt: AT("01:30:00"), startedAt: AT("02:00:00") }],
    });
    const outgoing = await seedTrip(database, base, {
      plate: "ZZ 1004 AA",
      flow: "OUT_PACKED",
      steps: [{ code: "LOADING", status: "IN_PROGRESS", readyAt: AT("02:00:00"), startedAt: AT("02:20:00") }],
    });
    const now = await state();
    expect(truckOf(now, waiting.tripId)).toMatchObject({ zone: "QUEUE", stepCode: "WEIGH_1", stepName: "Timbang 1 (bruto)", stepStatus: "READY", since: AT("01:10:00.000"), held: null });
    expect(truckOf(now, working.tripId)).toMatchObject({ zone: "UNLOADING", stepCode: "UNLOADING", stepStatus: "IN_PROGRESS", since: AT("02:00:00.000") });
    expect(truckOf(now, outgoing.tripId)).toMatchObject({ zone: "DOCK", stepCode: "LOADING", direction: "OUT", flowCode: "OUT_PACKED", since: AT("02:20:00.000") });
  });

  it("draws the exit step at the registration post, where the card is returned", async () => {
    const { database, base, state } = await setup();
    const { tripId } = await seedTrip(database, base, { plate: "ZZ 1005 AA", steps: [{ code: "CHECK_OUT", status: "READY", readyAt: AT("02:40:00") }] });
    expect(truckOf(await state(), tripId)).toMatchObject({ zone: "REG", stepCode: "CHECK_OUT", since: AT("02:40:00.000") });
  });

  it("holds a truck with a pending weighbridge decision at the weighbridge, since the request was raised", async () => {
    const { database, base, state } = await setup();
    const { tripId, steps } = await seedTrip(database, base, { plate: "ZZ 1006 AA", steps: [{ code: "WEIGH_1", status: "READY", readyAt: AT("01:00:00") }] });
    await seedException(database, tripId, { type: "GROSS_IN", raisedAt: AT("02:30:00"), stepId: steps.WEIGH_1 });
    expect(truckOf(await state(), tripId)).toMatchObject({
      zone: "WB",
      stepCode: "WEIGH_1",
      since: AT("02:30:00.000"),
      held: { type: "GROSS_IN", since: AT("02:30:00.000") },
    });
  });

  it("holds a truck with a pending QC hold at QC, since its QC step started", async () => {
    const { database, base, state } = await setup();
    // incoming goods do their QC in the staging zone; a hold still shows at QC
    const { tripId, steps } = await seedTrip(database, base, {
      plate: "ZZ 1007 AA",
      flow: "IN_GOODS",
      steps: [{ code: "QC", status: "IN_PROGRESS", result: "HOLD", readyAt: AT("01:00:00"), startedAt: AT("01:20:00") }],
    });
    await seedException(database, tripId, { type: "QC_HOLD", raisedAt: AT("01:40:00"), stepId: steps.QC });
    expect(truckOf(await state(), tripId)).toMatchObject({ zone: "QC", since: AT("01:20:00.000"), held: { type: "QC_HOLD", since: AT("01:40:00.000") } });
  });

  it("puts a weighbridge decision before a QC hold, and ignores requests that are no longer pending", async () => {
    const { database, base, state } = await setup();
    const both = await seedTrip(database, base, { plate: "ZZ 1008 AA", steps: [{ code: "WEIGH_2", status: "READY", readyAt: AT("02:00:00") }] });
    await seedException(database, both.tripId, { type: "QC_HOLD", raisedAt: AT("01:00:00") });
    await seedException(database, both.tripId, { type: "NET_IN", raisedAt: AT("02:10:00") });
    const closed = await seedTrip(database, base, { plate: "ZZ 1009 AA", steps: [{ code: "WEIGH_1", status: "READY", readyAt: AT("02:00:00") }] });
    await seedException(database, closed.tripId, { type: "PLATE", status: "CANCELLED", raisedAt: AT("02:05:00") });
    const now = await state();
    expect(truckOf(now, both.tripId)).toMatchObject({ zone: "WB", held: { type: "NET_IN" } });
    expect(truckOf(now, closed.tripId)).toMatchObject({ zone: "QUEUE", held: null });
  });

  it("keeps a truck that checked in yesterday and is still inside, and leaves out trucks not inside", async () => {
    const { database, base, state } = await setup();
    const yesterday = await seedTrip(database, base, {
      plate: "ZZ 1010 AA",
      status: "IN_PROCESS",
      checkedInAt: "2026-11-19T09:00:00Z",
      steps: [{ code: "UNLOADING", status: "READY", readyAt: "2026-11-19T12:00:00Z" }],
    });
    await seedTrip(database, base, { plate: "ZZ 1011 AA", status: "ISSUED", plannedArrival: "2026-11-20" });
    await seedTrip(database, base, { plate: "ZZ 1012 AA", status: "COMPLETED", checkedInAt: AT("00:00:00"), completedAt: AT("02:00:00") });
    await seedTrip(database, base, { plate: "ZZ 1013 AA", status: "CANCELLED", checkedInAt: null });
    const now = await state();
    expect(now.trucks.map((truck) => truck.plateDisplay)).toEqual(["ZZ 1010 AA"]);
    expect(truckOf(now, yesterday.tripId)).toMatchObject({ zone: "STAGING", since: "2026-11-19T12:00:00.000Z" });
  });
});

describe("GET /api/control-room/state: figures", () => {
  it("lists the nine zones with their colours, and the shapes of the demo plan while no plan is imported", async () => {
    const { state } = await setup();
    const now = await state();
    expect(now.zones.map((zone) => zone.code)).toEqual(["REG", "QUEUE", "WB", "QC", "STAGING", "DOCK", "LOADING", "UNLOADING", "SEAL"]);
    expect(now.zones[0]).toEqual({ code: "REG", name: "Pos registrasi (scan barcode, ambil dan kembalikan kartu)", kind: "REGISTRATION", color: "#e53935", shape: DEMO_ZONE_SHAPES.REG });
    expect(now.plantDay).toBe("2026-11-20");
    expect(now.generatedAt).toBe("2026-11-20T03:00:00.000Z");
  });

  it("counts trucks inside, expected today, pending decisions and trucks finished today with their average time inside", async () => {
    const { database, base, state } = await setup();
    const held = await seedTrip(database, base, { plate: "ZZ 1020 AA", steps: [{ code: "WEIGH_1", status: "READY", readyAt: AT("01:00:00") }] });
    await seedException(database, held.tripId, { type: "PLATE", raisedAt: AT("02:00:00") });
    await seedTrip(database, base, { plate: "ZZ 1021 AA", flow: "OUT_BULK", status: "IN_PROCESS" });
    await seedTrip(database, base, { plate: "ZZ 1022 AA", status: "ISSUED", plannedArrival: "2026-11-20" });
    await seedTrip(database, base, { plate: "ZZ 1023 AA", flow: "OUT_BULK", status: "ISSUED", plannedArrival: "2026-11-20" });
    await seedTrip(database, base, { plate: "ZZ 1024 AA", flow: "OUT_PACKED", status: "EXPIRED", plannedArrival: "2026-11-20" });
    await seedTrip(database, base, { plate: "ZZ 1025 AA", status: "ISSUED", plannedArrival: "2026-11-21" });
    // finished today: 60 and 90 minutes inside; one finished yesterday does not count
    await seedTrip(database, base, { plate: "ZZ 1026 AA", status: "COMPLETED", checkedInAt: AT("00:00:00"), completedAt: AT("01:00:00") });
    await seedTrip(database, base, { plate: "ZZ 1027 AA", status: "REJECTED", checkedInAt: AT("00:30:00"), completedAt: AT("02:00:00") });
    await seedTrip(database, base, { plate: "ZZ 1028 AA", status: "COMPLETED", checkedInAt: "2026-11-19T02:00:00Z", completedAt: "2026-11-19T05:00:00Z" });
    const now = await state();
    expect(now.upcoming).toEqual({ in: 1, out: 2 });
    expect(now.kpi).toEqual({ inside: 2, upcoming: 3, pendingDecisions: 1, finishedToday: 2, avgMinutesInPlantToday: 75 });
  });

  it("answers no average when nobody finished today", async () => {
    const { state } = await setup();
    expect((await state()).kpi).toEqual({ inside: 0, upcoming: 0, pendingDecisions: 0, finishedToday: 0, avgMinutesInPlantToday: null });
  });

  it("counts trucks per zone with the one that has waited longest", async () => {
    const { database, base, state } = await setup();
    await seedTrip(database, base, { plate: "ZZ 1030 AA", steps: [{ code: "WEIGH_1", status: "READY", readyAt: AT("02:30:00") }] });
    const longest = await seedTrip(database, base, { plate: "ZZ 1031 AA", steps: [{ code: "WEIGH_2", status: "READY", readyAt: AT("01:15:00") }] });
    await seedTrip(database, base, { plate: "ZZ 1032 AA", checkedInAt: AT("02:50:00") });
    const now = await state();
    expect(now.zoneStats.map((row) => row.zone)).toEqual(["REG", "QUEUE", "WB", "QC", "STAGING", "DOCK", "LOADING", "UNLOADING", "SEAL"]);
    const stat = (zone: string) => now.zoneStats.find((row) => row.zone === zone);
    expect(stat("QUEUE")).toEqual({ zone: "QUEUE", count: 2, longest: { tripId: longest.tripId, plateDisplay: "ZZ 1031 AA", minutes: 105 } });
    expect(stat("REG")).toMatchObject({ count: 1, longest: { minutes: 10 } });
    expect(stat("WB")).toEqual({ zone: "WB", count: 0, longest: null });
  });

  it("tells the step changes of today, newest first, joining a finished step with the next one that became ready", async () => {
    const { database, base, state } = await setup();
    const { tripId } = await seedTrip(database, base, {
      plate: "ZZ 1040 AA",
      checkedInAt: AT("01:00:00"),
      steps: [
        { code: "CHECK_IN", status: "DONE", result: "PASS", readyAt: AT("01:00:00"), startedAt: AT("01:00:00"), finishedAt: AT("01:00:00") },
        { code: "SEAL_CHECK", status: "DONE", result: "PASS", readyAt: AT("01:00:00"), startedAt: AT("01:10:00"), finishedAt: AT("01:20:00") },
        { code: "WEIGH_1", status: "DONE", result: "PASS", readyAt: AT("01:20:00"), startedAt: AT("01:40:00"), finishedAt: AT("01:40:00") },
        { code: "QC", status: "IN_PROGRESS", readyAt: AT("01:40:00"), startedAt: AT("02:00:00") },
      ],
    });
    // yesterday's changes are not today's
    await seedTrip(database, base, {
      plate: "ZZ 1041 AA",
      status: "IN_PROCESS",
      checkedInAt: "2026-11-19T09:00:00Z",
      steps: [{ code: "UNLOADING", status: "READY", readyAt: "2026-11-19T12:00:00Z" }],
    });
    const now = await state();
    expect(now.recent).toEqual([
      { at: AT("02:00:00.000"), tripId, plateDisplay: "ZZ 1040 AA", text: "ZZ 1040 AA mulai QC pass" },
      { at: AT("01:40:00.000"), tripId, plateDisplay: "ZZ 1040 AA", text: "ZZ 1040 AA selesai timbang 1, menunggu QC pass" },
      { at: AT("01:20:00.000"), tripId, plateDisplay: "ZZ 1040 AA", text: "ZZ 1040 AA selesai cek segel, menunggu timbang 1" },
      { at: AT("01:10:00.000"), tripId, plateDisplay: "ZZ 1040 AA", text: "ZZ 1040 AA mulai cek segel" },
      { at: AT("01:00:00.000"), tripId, plateDisplay: "ZZ 1040 AA", text: "ZZ 1040 AA check-in, menunggu cek segel" },
    ]);
  });

  it("keeps the 30 most recent step changes", async () => {
    const { database, base, state } = await setup();
    for (let index = 0; index < 20; index++) {
      const minute = String(index).padStart(2, "0");
      await seedTrip(database, base, {
        plate: `ZZ ${1100 + index} AB`,
        steps: [{ code: "UNLOADING", status: "IN_PROGRESS", readyAt: AT(`01:${minute}:00`), startedAt: AT(`02:${minute}:00`) }],
      });
    }
    const recent = (await state()).recent;
    expect(recent).toHaveLength(30);
    expect(recent[0]?.at).toBe(AT("02:19:00.000"));
    expect(recent.at(-1)?.at).toBe(AT("01:10:00.000"));
  });
});

describe("GET /api/control-room/trips/:id", () => {
  it("answers the steps, weighings and decision requests of one trip", async () => {
    const { database, base, get } = await setup();
    const { tripId, steps } = await seedTrip(database, base, {
      plate: "ZZ 1050 AA",
      checkedInAt: AT("01:00:00"),
      steps: [
        { code: "CHECK_IN", status: "DONE", result: "PASS", readyAt: AT("01:00:00"), startedAt: AT("01:00:00"), finishedAt: AT("01:00:00") },
        { code: "WEIGH_1", status: "DONE", result: "PASS", readyAt: AT("01:00:00"), startedAt: AT("01:30:00"), finishedAt: AT("01:30:00") },
        { code: "QC", status: "IN_PROGRESS", readyAt: AT("01:30:00"), startedAt: AT("02:00:00") },
        { code: "UNLOADING", status: "PENDING" },
      ],
    });
    await seedWeighing(database, base, tripId, { stage: 1, kind: "GROSS", kg: 31_250, at: AT("01:30:00"), mode: "EXCEPTION", plateCheck: "CONFIRMED" });
    await seedException(database, tripId, { type: "QC_HOLD", raisedAt: AT("02:10:00"), stepId: steps.QC });
    const response = await get(`/api/control-room/trips/${tripId}`);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.trip).toMatchObject({ id: tripId, tripNo: expect.any(String), plateDisplay: "ZZ 1050 AA", direction: "IN", flowCode: "IN_CPO", status: "CHECKED_IN", checkedInAt: AT("01:00:00.000") });
    expect(body.steps).toEqual([
      { code: "CHECK_IN", name: "Scan SPJ dan ambil kartu", status: "DONE", result: "PASS", readyAt: AT("01:00:00.000"), startedAt: AT("01:00:00.000"), finishedAt: AT("01:00:00.000"), minutes: 0 },
      { code: "WEIGH_1", name: "Timbang 1 (bruto)", status: "DONE", result: "PASS", readyAt: AT("01:00:00.000"), startedAt: AT("01:30:00.000"), finishedAt: AT("01:30:00.000"), minutes: 30 },
      { code: "QC", name: "QC pass", status: "IN_PROGRESS", result: null, readyAt: AT("01:30:00.000"), startedAt: AT("02:00:00.000"), finishedAt: null, minutes: 90 },
      { code: "UNLOADING", name: "Bongkar", status: "PENDING", result: null, readyAt: null, startedAt: null, finishedAt: null, minutes: null },
    ]);
    expect(body.weighings).toEqual([{ stage: 1, kind: "GROSS", kg: 31_250, at: AT("01:30:00.000"), mode: "EXCEPTION", plateCheck: "CONFIRMED", status: "VALID" }]);
    expect(body.exceptions).toEqual([{ type: "QC_HOLD", status: "PENDING", raisedAt: AT("02:10:00.000"), decidedAt: null, decisionCode: null }]);
  });

  it("answers 404 for an unknown trip", async () => {
    const { get } = await setup();
    const response = await get("/api/control-room/trips/999999");
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });
});

describe("GET /api/control-room/plan.svg", () => {
  it("serves the made-up demo plan while no plan was imported, as SVG that the browser may not sniff", async () => {
    const { get } = await setup();
    const response = await get("/api/control-room/plan.svg");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.body).toMatch(/^<svg [^>]*viewBox="0 0 1000 560"/);
    expect(response.body).not.toMatch(/<script|on\w+=/i);
  });
});

describe("control room access", () => {
  const URLS = ["/api/control-room/state", "/api/control-room/trips/1", "/api/control-room/plan.svg"];

  it("refuses staff without the dashboard module and partner accounts", async () => {
    const { app, database } = await setup();
    await seedStaff(database, "tanpa-dashboard", { gate: "EDIT", registrations: "EDIT" });
    const partnerId = await seedPartner(database, "PT Mitra Contoh", { supplier: true });
    await seedPartnerUser(database, "mitra", partnerId);
    // a partner account cannot be given the dashboard; even a row written by hand does not open it
    await database.query("insert into user_permissions (user_id, module_code, level) select id, 'dashboard', 'VIEW' from users where username = 'mitra'");
    for (const username of ["tanpa-dashboard", "mitra"]) {
      const headers = await bearer(app, username);
      for (const url of [...URLS, "/api/control-room/stream"]) {
        const response = await app.inject({ method: "GET", url, headers });
        expect(response.statusCode, `${username} ${url}`).toBe(403);
      }
    }
  });

  it("asks for a signed-in account", async () => {
    const { app } = await setup();
    for (const url of [...URLS, "/api/control-room/stream"]) expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
  });
});
